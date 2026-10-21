/**
 * Migration copy/verify logic over live ZenFS mounts (memory→memory in Node;
 * the same code path serves indexeddb↔opfs in the browser).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fs as zfs, umount } from '@zenfs/core';
import { configureStorageRoot, createMemoryStorageRoot, initFileSystem, migrateStorage, mountBackend, unmountBackend, type MigrationProgress } from './storage.js';

beforeEach(async () => {
  try {
    umount('/');
  } catch {
    // first run
  }
  await configureStorageRoot(await createMemoryStorageRoot());
});

describe('protected browser root', () => {
  it('rejects raw persistence and replacement before opening a backing device', async () => {
    await configureStorageRoot(await createMemoryStorageRoot(), { protectedPersistence: true });
    await zfs.promises.writeFile('/private-name.txt', 'private contents');

    await expect(mountBackend('/raw-opfs', { type: 'opfs' })).rejects.toThrow('encrypted browser vault');
    await expect(mountBackend('/raw-idb', { type: 'indexeddb' })).rejects.toThrow('encrypted browser vault');
    await expect(migrateStorage('opfs')).rejects.toThrow('expose plaintext');
    await expect(initFileSystem('memory')).rejects.toThrow('legacy raw storage cannot replace');
    expect(await zfs.promises.readFile('/private-name.txt', 'utf8')).toBe('private contents');
    expect(await zfs.promises.readdir('/')).toEqual(['private-name.txt']);
  });

  it('still permits volatile nested scratch mounts', async () => {
    await configureStorageRoot(await createMemoryStorageRoot(), { protectedPersistence: true });
    await mountBackend('/tmp', { type: 'memory' });
    try {
      await zfs.promises.writeFile('/tmp/transient.txt', 'volatile');
      expect(await zfs.promises.readFile('/tmp/transient.txt', 'utf8')).toBe('volatile');
    } finally {
      await unmountBackend('/tmp');
    }
  });
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
