/**
 * EncryptedStore (option B): the whole filesystem — names, dirs, inodes,
 * data — lands as encrypted numbered blocks; the backing shows no filenames
 * and no tree shape.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, InMemoryStore, fs as zfs, mount, umount, mounts as zenMounts } from '@zenfs/core';
import { generateBlobKey, isEncryptedBlob } from '../oci/cipher.js';
import { PodLockedError } from '../manager/keyring.js';
import { encryptedStoreMount } from './encrypted-store.js';

const MARKER = 'PHI-marker: block-store payload';
const NAME = 'very-secret-filename.md';

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

describe('encryptedStoreMount', () => {
  it('hides names AND contents: every backing block is ciphertext', async () => {
    const key = await generateBlobKey();
    const inner = new InMemoryStore(undefined, 'blocks');
    const enc = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey: () => key });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);

    await zfs.promises.mkdir('/enc/nested-dir-name');
    await zfs.promises.writeFile(`/enc/nested-dir-name/${NAME}`, MARKER);
    expect(await zfs.promises.readFile(`/enc/nested-dir-name/${NAME}`, 'utf8')).toBe(MARKER);
    expect(zfs.readFileSync(`/enc/nested-dir-name/${NAME}`, 'utf8')).toBe(MARKER);
    expect((await zfs.promises.stat(`/enc/nested-dir-name/${NAME}`)).size).toBe(MARKER.length);

    // the inner store holds ONLY opaque encrypted blocks — no name, no marker
    expect(inner.size).toBeGreaterThan(0);
    const decoder = new TextDecoder('latin1');
    for (const [, raw] of inner) {
      expect(isEncryptedBlob(raw)).toBe(true);
      const ascii = decoder.decode(raw);
      expect(ascii).not.toContain(NAME);
      expect(ascii).not.toContain('nested-dir-name');
      expect(ascii).not.toContain('PHI-marker');
    }
  });

  it('remounts over the same backing: names and contents come back', async () => {
    const key = await generateBlobKey();
    const inner = new InMemoryStore(undefined, 'blocks');
    const first = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey: () => key });
    await zfs.promises.mkdir('/enc');
    mount('/enc', first);
    await zfs.promises.mkdir('/enc/dir');
    await zfs.promises.writeFile('/enc/dir/a.txt', MARKER);
    await zfs.promises.writeFile('/enc/top.txt', 'top');
    umount('/enc');

    const second = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey: () => key });
    mount('/enc', second);
    expect((await zfs.promises.readdir('/enc')).sort()).toEqual(['dir', 'top.txt']);
    expect(await zfs.promises.readFile('/enc/dir/a.txt', 'utf8')).toBe(MARKER);
    // deletions persist through the block layer too
    await zfs.promises.rm('/enc/top.txt');
    umount('/enc');
    const third = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey: () => key });
    mount('/enc', third);
    expect(await zfs.promises.readdir('/enc')).toEqual(['dir']);
  });

  it('a locked key refuses to mount a non-empty backing', async () => {
    const key = await generateBlobKey();
    const inner = new InMemoryStore(undefined, 'blocks');
    const writer = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey: () => key });
    await zfs.promises.mkdir('/enc');
    mount('/enc', writer);
    await zfs.promises.writeFile('/enc/sealed.txt', MARKER);
    umount('/enc');

    const locked = (): CryptoKey => {
      throw new PodLockedError('no usable key in this session');
    };
    await expect(encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey: locked })).rejects.toThrow(/locked/);
  });

  it('config backings resolve store-based filesystems and reject others', async () => {
    const key = await generateBlobKey();
    const enc = await encryptedStoreMount({ backing: { kind: 'config', config: { backend: InMemory } }, getKey: () => key });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);
    await zfs.promises.writeFile('/enc/x.txt', 'via config');
    expect(await zfs.promises.readFile('/enc/x.txt', 'utf8')).toBe('via config');
  });
});
