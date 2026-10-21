import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZenFsLike } from '../sandbox/types.js';
import { createStorageSession, type StorageSession } from '../storage/index.js';
import { createNativeStorageAdapters } from '../storage/node.js';
import { generateBlobKey } from './cipher.js';
import { OciStore, SUPERBLOCK_PATH } from './store.js';

const sessions: StorageSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function memoryStore() {
  const session = createStorageSession({ policy: 'memory' });
  sessions.push(session);
  const storage = await session.open();
  const store = new OciStore(storage.zfs, { storage });
  await store.init();
  return { storage, store };
}

describe('OCI metadata fail-closed behavior', () => {
  it.each(['EACCES', 'EIO'])('does not replace an unreadable superblock or create metadata on %s', async code => {
    const failure = Object.assign(new Error('saved superblock unavailable'), { code });
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const zfs = { promises: { mkdir, writeFile, readFile: vi.fn(async () => { throw failure; }) } } as unknown as ZenFsLike;
    await expect(new OciStore(zfs).init()).rejects.toBe(failure);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each(['{invalid', 'null', '[]', '{"formatVersion":1}', '{"formatVersion":2}'])('preserves a malformed existing superblock: %s', async text => {
    const { storage, store } = await memoryStore();
    await storage.zfs.promises.writeFile(SUPERBLOCK_PATH, text);
    await expect(store.init()).rejects.toThrow();
    expect(await storage.zfs.promises.readFile(SUPERBLOCK_PATH, 'utf8')).toBe(text);
    expect(() => store.getSuperblock()).toThrow('store not initialized');
  });

  it('does not hide corrupt ref metadata as an empty saved workspace', async () => {
    const { storage, store } = await memoryStore();
    const path = '/.artipod/oci/refs/private%3A1.json';
    await storage.zfs.promises.writeFile(path, '{corrupt');
    await expect(store.getRef('private:1')).rejects.toThrow();
    await expect(store.listRefs()).rejects.toThrow();
    expect(await storage.zfs.promises.readFile(path, 'utf8')).toBe('{corrupt');
  });

  it('denies cached identity and absence queries after lease loss or session close', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'artipod-store-policy-'));
    directories.push(directory);
    const original = await generateBlobKey();
    let key: CryptoKey | null = original;
    const session = createStorageSession({ adapters: await createNativeStorageAdapters(directory), keys: {
      getKey: () => key,
      requireKey: () => { if (!key) throw new Error('EACCES: lease unavailable'); return key; },
      storagePolicy: 'encrypted', async suspendForReset() { return () => {}; },
    } });
    sessions.push(session);
    const storage = await session.open();
    const store = new OciStore(storage.zfs, { storage });
    await store.init();
    expect(store.getSuperblock().podId).toBeTruthy();
    key = null;
    try {
      expect(() => store.getSuperblock()).toThrow('EACCES: lease unavailable');
      const digest = `sha256:${'0'.repeat(64)}` as const;
      await expect(store.hasBlob(digest)).rejects.toThrow('EACCES: lease unavailable');
      await expect(store.getBlob(digest)).rejects.toThrow('EACCES: lease unavailable');
      await expect(store.resolveAlias(digest)).rejects.toThrow('EACCES: lease unavailable');
      await expect(store.hasUncompressed(digest)).rejects.toThrow('EACCES: lease unavailable');
      await expect(store.getRef('private:1')).rejects.toThrow('EACCES: lease unavailable');
      await expect(store.deleteRef('private:1')).rejects.toThrow('EACCES: lease unavailable');
      await expect(store.listRefs()).rejects.toThrow('EACCES: lease unavailable');
    } finally { key = original; }
    await session.close();
    expect(() => store.getSuperblock()).toThrow('core storage context');
  });
});
