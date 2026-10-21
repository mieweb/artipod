import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Authority } from '../manager/authority.js';
import { createKeysHandler } from '../server/keys-handler.js';
import { createStorageSession, KeysService, nodeAdapters, readStorageTextFile, type StorageSession } from '../storage/index.js';
import { createNativeStorageAdapters } from '../storage/node.js';
import { generateBlobKey } from './cipher.js';
import { readPodSettings, writePodSettings, SETTINGS_PATH } from './settings.js';

const sessions: StorageSession[] = [];
const providers: KeysService[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
  for (const keys of providers.splice(0)) { keys.release(); keys.scheduler.dispose(); }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function broker(): Promise<typeof fetch> {
  const authority = await Authority.create('settings-test');
  const podId = 'settings-test-pod';
  authority.registerPod(podId, new Uint8Array(32).fill(7));
  const handler = createKeysHandler({ authority, podIds: [podId], capTtlMs: 3600_000 });
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    return handler(new Request(`http://broker${path}`, init), path.split('/').filter(Boolean).slice(2));
  }) as typeof fetch;
}

describe('atomic protected settings replacement', () => {
  it.each([2, 8])('preserves complete settings at raw write failure %i and replays the pending offline preference after recovery', async failAt => {
    const directory = await mkdtemp(join(tmpdir(), 'artipod-atomic-settings-'));
    directories.push(directory);
    let failing = false;
    let stagedWrites = 0;
    const failure = new Error('Injected settings staging failure');
    const adapters = await createNativeStorageAdapters(directory, { onWrite: path => {
      // Persist one encrypted transaction record, then interrupt the next.
      // An in-place false -> true update can now pair new data with old size.
      if (failing && path.includes('/generations/') && ++stagedWrites === failAt) throw failure;
    } });
    const keys = new KeysService(nodeAdapters({ fetch: await broker() }));
    providers.push(keys);
    expect(await keys.login('tester')).toBe(true);
    const session = createStorageSession({ keys, adapters });
    sessions.push(session);
    const original = await session.open();
    keys.setForcedOffline(false);
    await keys.flushOfflinePreference();
    const saved = await original.zfs.promises.readFile(SETTINGS_PATH, 'utf8');
    expect(saved).toBe('{\n  "offline": false\n}');

    failing = true;
    keys.setForcedOffline(true);
    await expect(keys.flushOfflinePreference()).rejects.toThrow();
    expect(stagedWrites).toBeGreaterThanOrEqual(failAt);
    expect(keys.forcedOffline).toBe(true);
    expect(session.needsRecovery()).toBe(true);
    failing = false;
    // Hold the automatic replay just long enough to inspect the saved bytes.
    const replay = vi.spyOn(keys, 'flushOfflinePreference').mockResolvedValue(undefined);
    const recovered = await session.recover();
    expect(await readStorageTextFile({ zfs: recovered.info.zfs, path: SETTINGS_PATH, previousPath: '/.artipod/oci/.settings.previous' })).toBe(saved);
    expect(await readPodSettings(recovered.info.zfs)).toEqual({ offline: false });
    replay.mockRestore();
    await keys.flushOfflinePreference();
    expect(await readPodSettings(recovered.info.zfs)).toEqual({ offline: true });
    expect(await recovered.info.zfs.promises.readFile(SETTINGS_PATH, 'utf8')).toBe('{\n  "offline": true\n}');
    expect(session.needsRecovery()).toBe(false);
  });

  it.each([false, true])('keeps complete old/new JSON at every native write fault, including fallback cleanup (existing fallback: %s)', async existingFallback => {
    const observed: number[] = [];
    for (let failAt = 1; failAt <= 40; failAt++) {
      const directory = await mkdtemp(join(tmpdir(), 'artipod-settings-fault-sweep-'));
      directories.push(directory);
      let armed = false;
      let writes = 0;
      const key = await generateBlobKey();
      const keys = { getKey: () => key, requireKey: () => key, storagePolicy: 'encrypted' as const, suspendForReset: async () => () => {} };
      const adapters = await createNativeStorageAdapters(directory, { onWrite: path => {
        if (armed && path.includes('/generations/') && ++writes === failAt) throw new Error(`Injected raw settings write ${failAt}`);
      } });
      const first = createStorageSession({ keys, adapters });
      sessions.push(first);
      const storage = await first.open();
      await writePodSettings(storage.zfs, { offline: false });
      if (existingFallback) await writePodSettings(storage.zfs, { offline: true });
      const before = JSON.stringify({ offline: existingFallback }, null, 2);
      const after = JSON.stringify({ offline: !existingFallback }, null, 2);
      armed = true;
      let failed = false;
      try { await writePodSettings(storage.zfs, { offline: !existingFallback }); }
      catch { failed = true; }
      armed = false;
      if (failed) expect(first.needsRecovery()).toBe(true);
      await first.close().catch(() => {});
      const next = createStorageSession({ keys, adapters: await createNativeStorageAdapters(directory) });
      sessions.push(next);
      const reopened = await next.open();
      const text = await readStorageTextFile({ zfs: reopened.zfs, path: SETTINGS_PATH, previousPath: '/.artipod/oci/.settings.previous' });
      expect([before, after], `fault ${failAt}, fallback ${existingFallback}`).toContain(text);
      expect(await readPodSettings(reopened.zfs)).toEqual(JSON.parse(text!));
      await writePodSettings(reopened.zfs, { offline: !existingFallback });
      expect(await readPodSettings(reopened.zfs)).toEqual({ offline: !existingFallback });
      await next.close();
      observed.push(failAt);
      if (!failed) { expect(writes).toBeLessThan(failAt); break; }
    }
    expect(observed).toContain(8);
    expect(observed.length).toBeLessThan(40);
  }, 30_000);
});
