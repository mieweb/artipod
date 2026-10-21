import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Authority } from '../manager/authority.js';
import { createKeysHandler } from '../server/keys-handler.js';
import { createStorageSession, KeysService, nodeAdapters, type StorageSession } from '../storage/index.js';
import { createNativeStorageAdapters } from '../storage/node.js';
import { readPodSettings, SETTINGS_PATH } from './settings.js';

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
  it('preserves exact saved JSON after a queued shrink fails and replays the pending offline preference after recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artipod-atomic-settings-'));
    directories.push(directory);
    let failing = false;
    let stagedWrites = 0;
    const failure = new Error('Injected settings staging failure');
    const adapters = await createNativeStorageAdapters(directory, { onWrite: path => {
      // Persist one encrypted transaction record, then interrupt the next.
      // An in-place false -> true update can now pair new data with old size.
      if (failing && path.includes('/generations/') && ++stagedWrites === 2) throw failure;
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
    expect(stagedWrites).toBeGreaterThanOrEqual(2);
    expect(keys.forcedOffline).toBe(true);
    expect(session.needsRecovery()).toBe(true);
    failing = false;
    // Hold the automatic replay just long enough to inspect the saved bytes.
    const replay = vi.spyOn(keys, 'flushOfflinePreference').mockResolvedValue(undefined);
    const recovered = await session.recover();
    expect(await recovered.info.zfs.promises.readFile(SETTINGS_PATH, 'utf8')).toBe(saved);
    expect(await readPodSettings(recovered.info.zfs)).toEqual({ offline: false });
    replay.mockRestore();
    await keys.flushOfflinePreference();
    expect(await readPodSettings(recovered.info.zfs)).toEqual({ offline: true });
    expect(await recovered.info.zfs.promises.readFile(SETTINGS_PATH, 'utf8')).toBe('{\n  "offline": true\n}');
    expect(session.needsRecovery()).toBe(false);
  });
});
