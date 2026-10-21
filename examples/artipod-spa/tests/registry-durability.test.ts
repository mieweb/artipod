import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorageSession, type StorageSession } from '@artipod/core/storage';
import { createNativeStorageAdapters } from '@artipod/core/storage/node';
import { generateBlobKey } from '@artipod/core/oci';
import type { ZenFsLike } from '@artipod/core/sandbox';
import { registryStateMedium, REGISTRY_PATH } from '../lib/services/registry-medium';
import { UiStateIO } from '../lib/services/ui-state';

const sessions: StorageSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })));
});

describe('protected registry replacement', () => {
  it.each([2, 5])('preserves saved JSON when a registry shrink fails at encrypted record %s and can retry after recovery', async failAt => {
    const directory = await mkdtemp(join(tmpdir(), 'artipod-registry-'));
    directories.push(directory);
    let failing = false;
    let writes = 0;
    const adapters = await createNativeStorageAdapters(directory, { onWrite: path => {
      if (failing && path.includes('/generations/') && ++writes === failAt) throw new Error('Injected registry staging failure');
    } });
    const key = await generateBlobKey();
    const session = createStorageSession({ adapters, keys: { storagePolicy: 'encrypted', getKey: () => key, requireKey: () => key, suspendForReset: async () => () => {} } });
    sessions.push(session);
    let info = await session.open();
    const medium = registryStateMedium(async () => ({ fs: info.zfs, flushFileSystem: () => session.flush() }));
    const registry = new UiStateIO(medium);
    await registry.recordWorkspace('PRIVATE-patient-one', 'blank', 'rw');
    await registry.recordWorkspace('PRIVATE-patient-two', 'blank', 'rw');
    const saved = await medium.read();
    const parsed = await registry.read();

    failing = true;
    await expect(registry.drop(['PRIVATE-patient-one'])).rejects.toThrow();
    expect(writes).toBeGreaterThanOrEqual(failAt);
    expect(session.needsRecovery()).toBe(true);
    failing = false;
    info = (await session.recover()).info;
    expect(await info.zfs.promises.readFile(REGISTRY_PATH, 'utf8')).toBe(saved);
    expect(await registry.read()).toEqual(parsed);
    await registry.drop(['PRIVATE-patient-one']);
    expect((await registry.read()).workspaces.map(entry => entry.id)).toEqual(['PRIVATE-patient-two']);
    await session.close();
    info = await session.open();
    expect((await registry.read()).workspaces.map(entry => entry.id)).toEqual(['PRIVATE-patient-two']);
  });

  it.each([
    ['retire', 1], ['retire', 2], ['backup', 1], ['backup', 2],
    ['install', 1], ['install', 2], ['cleanup', 1],
  ] as const)('recovers a complete registry after %s fails at raw record %s', async (failurePhase, failAt) => {
    const directory = await mkdtemp(join(tmpdir(), 'artipod-registry-rename-'));
    directories.push(directory);
    const failure = new Error(`Injected ${failurePhase} failure`);
    let phase = '';
    let armed = false;
    let records = 0;
    const adapters = await createNativeStorageAdapters(directory, { onWrite: path => {
      if (armed && phase === failurePhase && path.includes('/generations/') && ++records === failAt) throw failure;
    } });
    const generation = adapters.generation.bind(adapters);
    adapters.generation = async (...args) => {
      const backing = await generation(...args);
      if (backing.kind === 'store') {
        const store = backing.store as typeof backing.store & { delete(id: number): Promise<void> };
        const remove = store.delete.bind(store);
        store.delete = async id => {
          const result = await remove(id);
          if (armed && phase === 'cleanup' && failurePhase === 'cleanup' && ++records === failAt) throw failure;
          return result;
        };
      }
      return backing;
    };
    const key = await generateBlobKey();
    const session = createStorageSession({ adapters, keys: { storagePolicy: 'encrypted', getKey: () => key, requireKey: () => key, suspendForReset: async () => () => {} } });
    sessions.push(session);
    let info = await session.open();
    const medium = registryStateMedium(async () => {
      const source = info.zfs.promises;
      const promises = new Proxy(source, { get(target, name) {
        if (name === 'rename') return async (from: string, to: string) => {
          phase = from === REGISTRY_PATH ? 'backup' : from === '/.artipod/.ui-state.previous' ? 'retire' : 'install';
          try { return await source.rename(from, to); }
          finally { phase = ''; }
        };
        if (name === 'unlink') return async (path: string) => {
          phase = 'cleanup';
          try { return await source.unlink(path); }
          finally { phase = ''; }
        };
        return Reflect.get(target, name);
      } });
      return { fs: { promises } as ZenFsLike, flushFileSystem: () => session.flush() };
    });
    const registry = new UiStateIO(medium);
    await registry.recordWorkspace('PRIVATE-one', 'blank', 'rw');
    await registry.recordWorkspace('PRIVATE-two', 'blank', 'rw');
    const saved = await registry.read();
    armed = true;
    await expect(registry.drop(['PRIVATE-one'])).rejects.toThrow();
    expect(records).toBe(failAt);
    expect(session.needsRecovery()).toBe(true);
    armed = false;
    info = (await session.recover()).info;
    const recovered = await registry.read();
    const next = { ...saved, workspaces: saved.workspaces.filter(entry => entry.id !== 'PRIVATE-one') };
    expect([JSON.stringify(saved), JSON.stringify(next)]).toContain(JSON.stringify(recovered));
    if (failurePhase !== 'install') expect(recovered).toEqual(saved);
    await registry.drop(['PRIVATE-one']);
    await session.close();
    info = await session.open();
    expect((await registry.read()).workspaces.map(entry => entry.id)).toEqual(['PRIVATE-two']);
  });
});
