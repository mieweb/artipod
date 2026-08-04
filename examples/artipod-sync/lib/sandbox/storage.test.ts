/**
 * Migration copy/verify logic over live ZenFS mounts (memory→memory in Node;
 * the same code path serves indexeddb↔opfs in the browser).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { migrateStorage, type MigrationProgress } from './storage';

beforeEach(async () => {
  try {
    umount('/');
  } catch {
    // first run
  }
  await configure({ mounts: { '/': InMemory } });
});

describe('migrateStorage', () => {
  it('copies all files and directories and reports progress', async () => {
    await zfs.promises.mkdir('/repo/src/deep', { recursive: true });
    await zfs.promises.writeFile('/repo/readme.md', 'hello');
    await zfs.promises.writeFile('/repo/src/a.ts', 'const a = 1;');
    await zfs.promises.writeFile('/repo/src/deep/b.bin', new Uint8Array([1, 2, 3]));

    const events: MigrationProgress[] = [];
    const { files, bytes } = await migrateStorage('memory', (p) => events.push(p));

    expect(files).toBe(3);
    expect(bytes).toBe(5 + 12 + 3);
    expect(events.length).toBe(3);
    expect(events[events.length - 1].copied).toBe(3);
    // migration mount must be gone again
    expect(await zfs.promises.exists('/__migrate')).toBe(false);
  });

  it('handles an empty filesystem', async () => {
    const { files, bytes } = await migrateStorage('memory');
    expect(files).toBe(0);
    expect(bytes).toBe(0);
  });
});
