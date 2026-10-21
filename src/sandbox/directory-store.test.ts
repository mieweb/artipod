import { beforeEach, describe, expect, it } from 'vitest';
import { configure, CopyOnWrite, InMemory, InMemoryStore, fs as zfs, mount, mounts, resolveMountConfig, umount } from '@zenfs/core';
import { generateBlobKey, isEncryptedBlob } from '../oci/cipher.js';
import { directoryMount, directoryStore } from './directory-store.js';
import { encryptedStoreMount } from './encrypted-store.js';

const NAME = 'synthetic-private-filename.csv';
const MARKER = 'synthetic-private-content';

beforeEach(async () => {
  for (const path of [...mounts.keys()].sort((a, b) => b.length - a.length)) umount(path);
  await configure({ mounts: { '/': InMemory } });
});

describe('directories inside an encrypted root', () => {
  it('uses a directory as a CoW upper without plaintext backing or recursive mounts', async () => {
    const key = await generateBlobKey();
    const backing = new InMemoryStore();
    const root = await encryptedStoreMount({ backing: { kind: 'store', store: backing }, getKey: () => key, strictCiphertext: true });
    await configure({ mounts: { '/': root } });
    await zfs.promises.mkdir('/basis');
    await zfs.promises.writeFile(`/basis/${NAME}`, 'header\nrow1\n');
    await zfs.promises.writeFile('/basis/removed.txt', 'lower');
    const lower = await directoryMount(zfs, '/basis');
    const upper = await directoryMount(zfs, '/.artipod/workspace-uppers/test');
    const cow = await resolveMountConfig({ backend: CopyOnWrite, readable: lower, writable: upper } as never);
    await zfs.promises.mkdir('/workspace');
    mount('/workspace', cow);
    expect(await zfs.promises.readFile(`/workspace/${NAME}`, 'utf8')).toBe('header\nrow1\n');
    await zfs.promises.appendFile(`/workspace/${NAME}`, 'row2\n');
    expect(await zfs.promises.readFile(`/workspace/${NAME}`, 'utf8')).toBe('header\nrow1\nrow2\n');
    expect(await zfs.promises.readFile(`/basis/${NAME}`, 'utf8')).toBe('header\nrow1\n');
    await zfs.promises.mkdir('/workspace/nested');
    await zfs.promises.writeFile('/workspace/nested/new.txt', MARKER);
    await zfs.promises.rename('/workspace/nested/new.txt', '/workspace/nested/renamed.txt');
    await zfs.promises.unlink('/workspace/removed.txt');
    await expect(zfs.promises.stat('/workspace/removed.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await zfs.promises.readFile('/basis/removed.txt', 'utf8')).toBe('lower');
    await root.flush();
    expect([...backing.values()].every(isEncryptedBlob)).toBe(true);
    for (const bytes of backing.values()) {
      const raw = new TextDecoder().decode(bytes);
      expect(raw).not.toContain(NAME);
      expect(raw).not.toContain(MARKER);
    }
    umount('/workspace');
    const reopened = await encryptedStoreMount({ backing: { kind: 'store', store: backing }, getKey: () => key, strictCiphertext: true });
    await configure({ mounts: { '/': reopened } });
    expect(await zfs.promises.readFile(`/.artipod/workspace-uppers/test/${NAME}`, 'utf8')).toBe('header\nrow1\nrow2\n');
    expect(await zfs.promises.readFile('/.artipod/workspace-uppers/test/nested/renamed.txt', 'utf8')).toBe(MARKER);
  });

  it('preserves symlink identity through a directory mount', async () => {
    await zfs.promises.mkdir('/backing');
    await zfs.promises.writeFile('/backing/data.txt', MARKER);
    await zfs.promises.symlink('data.txt', '/backing/link.txt');
    const view = await directoryMount(zfs, '/backing');
    await zfs.promises.mkdir('/view');
    mount('/view', view);
    expect((await zfs.promises.lstat('/view/link.txt')).isSymbolicLink()).toBe(true);
    expect(await zfs.promises.readlink('/view/link.txt')).toBe('data.txt');
    expect(await zfs.promises.readFile('/view/link.txt', 'utf8')).toBe(MARKER);
  });

  it('opens legacy encrypted numeric blocks copied inside the encrypted root', async () => {
    const key = await generateBlobKey();
    const legacyBacking = new InMemoryStore();
    const legacy = await encryptedStoreMount({ backing: { kind: 'store', store: legacyBacking }, getKey: () => key });
    await legacy.createFile(`/${NAME}`, { uid: 0, gid: 0, mode: 0o644 });
    const bytes = new TextEncoder().encode(MARKER);
    await legacy.write(`/${NAME}`, bytes, 0);
    await legacy.touch(`/${NAME}`, { size: bytes.length });
    await legacy.flush();
    const rootBacking = new InMemoryStore();
    const root = await encryptedStoreMount({ backing: { kind: 'store', store: rootBacking }, getKey: () => key });
    await configure({ mounts: { '/': root } });
    await zfs.promises.mkdir('/legacy-blocks');
    for (const [id, encrypted] of legacyBacking) await zfs.promises.writeFile(`/legacy-blocks/${id}`, encrypted);
    const store = await directoryStore({ zfs, directory: '/legacy-blocks', flush: () => root.flush() });
    const old = await encryptedStoreMount({ backing: { kind: 'store', store }, getKey: () => key, strictCiphertext: true });
    const result = new Uint8Array((await old.stat(`/${NAME}`)).size);
    await old.read(`/${NAME}`, result, 0, result.length);
    expect(new TextDecoder().decode(result)).toBe(MARKER);
    await old.flush();
    expect([...rootBacking.values()].every(isEncryptedBlob)).toBe(true);
  });

  it('checks the root lease through cached directory views and permits the same mount after unlock', async () => {
    const key = await generateBlobKey();
    let unlocked = true;
    const root = await encryptedStoreMount({
      backing: { kind: 'store', store: new InMemoryStore() }, getKey: () => key,
      assertAccess: () => { if (!unlocked) throw new Error('lease expired'); },
    });
    await configure({ mounts: { '/': root } });
    await zfs.promises.mkdir('/backing');
    await zfs.promises.writeFile('/backing/data.txt', MARKER);
    const view = await directoryMount(zfs, '/backing');
    await zfs.promises.mkdir('/view');
    mount('/view', view);
    expect(await zfs.promises.readFile('/view/data.txt', 'utf8')).toBe(MARKER);
    await root.flush();
    unlocked = false;
    await expect(zfs.promises.readFile('/view/data.txt', 'utf8')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(zfs.promises.readdir('/view')).rejects.toMatchObject({ code: 'EACCES' });
    unlocked = true;
    expect(await zfs.promises.readFile('/view/data.txt', 'utf8')).toBe(MARKER);
    await root.flush();
  });
});
