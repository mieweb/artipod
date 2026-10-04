/**
 * Pod-resident offline mode: `artipod offline [on|off]` writes
 * /.artipod/settings.json, sync verbs refuse while it is on, and the same
 * file drives every surface (browser shells, node CLI, demo network layer).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import type { ZenFsLike } from '../sandbox/types.js';
import type { Sandbox } from '../sandbox/types.js';
import { createSandbox } from '../sandbox/index.js';
import { OciStore } from './store.js';
import { makeArtipodCommand } from './command.js';
import { readPodSettings, writePodSettings } from './settings.js';
import type { PodStore } from '../manager/pod-store.js';

function unmountAll(): void {
  for (const path of [...zenMounts.keys()]) {
    if (path !== '/') umount(path);
  }
  try {
    umount('/');
  } catch {
    // first run
  }
}

beforeEach(async () => {
  unmountAll();
  await configure({ mounts: { '/': InMemory } });
});

const failingRemote = new Proxy({} as PodStore, {
  get() {
    throw new Error('remote must not be touched while offline');
  },
});

async function shell(): Promise<Sandbox> {
  const store = new OciStore(zfs as unknown as ZenFsLike);
  await store.init();
  return createSandbox({
    zfs: zfs as unknown as ZenFsLike,
    extraCommands: [
      makeArtipodCommand({
        store,
        zfs: zfs as unknown as ZenFsLike,
        remote: failingRemote,
        tasks: () => [
          { name: 'keys:renew', state: 'scheduled', nextRunAt: Date.now() + 3_540_000, lastRunAt: Date.now() - 60_000, lastResult: 'ok' },
          { name: 'sync:push', state: 'idle', lastResult: 'error', lastError: 'forced offline' },
        ],
      }),
    ],
  });
}

describe('artipod ps', () => {
  it('prints the app task table (the scheduler is app-provided)', async () => {
    const sb = await shell();
    const res = await sb.exec('artipod ps');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('TASK');
    expect(res.stdout).toContain('keys:renew');
    expect(res.stdout).toContain('next in 59m');
    expect(res.stdout).toContain('error: forced offline');
  });

  it('explains itself when no scheduler is wired', async () => {
    const store = new OciStore(zfs as unknown as ZenFsLike);
    await store.init();
    const bare = createSandbox({
      zfs: zfs as unknown as ZenFsLike,
      extraCommands: [makeArtipodCommand({ store, zfs: zfs as unknown as ZenFsLike })],
    });
    const res = await bare.exec('artipod ps');
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('no task scheduler');
  });
});

describe('artipod offline', () => {
  it('round-trips through settings.json and gates push/pull/clone', async () => {
    const sb = await shell();
    expect((await sb.exec('artipod offline')).stdout).toContain('offline mode is off');

    const on = await sb.exec('artipod offline on');
    expect(on.exitCode).toBe(0);
    expect(on.stdout).toContain('offline mode ON');
    expect((await readPodSettings(zfs as unknown as ZenFsLike)).offline).toBe(true);

    for (const verb of ['push some:ref', 'pull some:ref', 'clone some:ref']) {
      const result = await sb.exec(`artipod ${verb}`);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('offline mode is on');
    }

    expect((await sb.exec('artipod offline')).stdout).toContain('ON');
    const off = await sb.exec('artipod offline off');
    expect(off.stdout).toContain('offline mode OFF');
    expect((await readPodSettings(zfs as unknown as ZenFsLike)).offline).toBe(false);
    // back online: the verb runs again (fails on the missing ref, not the gate)
    const push = await sb.exec('artipod push some:ref');
    expect(push.stderr).toContain('not found in the source store');
  });

  it('writePodSettings patches without clobbering other keys', async () => {
    const fs = zfs as unknown as ZenFsLike;
    await writePodSettings(fs, { offline: true });
    const next = await writePodSettings(fs, {});
    expect(next.offline).toBe(true);
  });
});
