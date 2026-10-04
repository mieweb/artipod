/**
 * EncryptedFS (serve plan S5.5 follow-up — the working-tree gap): contents
 * are chunked-AEAD ciphertext on the inner backend, plaintext only in the
 * in-memory sync mirror; key evaporation refuses mounts/reads.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, mount, umount, mounts as zenMounts, resolveMountConfig, type FileSystem } from '@zenfs/core';
import { generateBlobKey, isEncryptedBlob } from '../oci/cipher.js';
import { PodLockedError } from '../manager/keyring.js';
import { encryptedMount } from './encrypted-fs.js';

const MARKER = 'PHI-marker: sealed working tree';

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

async function innerFile(inner: FileSystem, path: string): Promise<Uint8Array> {
  const inode = await inner.stat(path);
  const raw = new Uint8Array(inode.size);
  await inner.read(path, raw, 0, inode.size);
  return raw;
}

describe('encryptedMount', () => {
  it('round-trips through the VFS while the inner backend holds only ciphertext', async () => {
    const key = await generateBlobKey();
    const inner = await resolveMountConfig({ backend: InMemory });
    const enc = await encryptedMount({ inner, getKey: () => key });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);

    await zfs.promises.writeFile('/enc/a.txt', MARKER);
    await zfs.promises.mkdir('/enc/sub');
    await zfs.promises.writeFile('/enc/sub/b.txt', `${MARKER} two`);

    // async + sync read paths (the mixin's plaintext mirror)
    expect(await zfs.promises.readFile('/enc/a.txt', 'utf8')).toBe(MARKER);
    expect(zfs.readFileSync('/enc/sub/b.txt', 'utf8')).toBe(`${MARKER} two`);
    // stat reports PLAINTEXT sizes
    expect((await zfs.promises.stat('/enc/a.txt')).size).toBe(MARKER.length);

    // at rest: ciphertext, structure visible, contents not
    const raw = await innerFile(inner, '/a.txt');
    expect(isEncryptedBlob(raw)).toBe(true);
    expect(new TextDecoder().decode(raw)).not.toContain('PHI-marker');
    expect((await inner.stat('/a.txt')).size).toBeGreaterThan(MARKER.length); // header + tag overhead

    // rename + shrink-overwrite (stale ciphertext tail must not resurrect)
    await zfs.promises.rename('/enc/a.txt', '/enc/renamed.txt');
    await zfs.promises.writeFile('/enc/renamed.txt', 'x');
    expect(await zfs.promises.readFile('/enc/renamed.txt', 'utf8')).toBe('x');
    expect((await zfs.promises.stat('/enc/renamed.txt')).size).toBe(1);
    await zfs.promises.rm('/enc/sub/b.txt');
    expect(await zfs.promises.readdir('/enc/sub')).toEqual([]);
  });

  it('a remount over the same inner backend decrypts what the first wrote', async () => {
    const key = await generateBlobKey();
    const inner = await resolveMountConfig({ backend: InMemory });
    const first = await encryptedMount({ inner, getKey: () => key });
    await zfs.promises.mkdir('/enc');
    mount('/enc', first);
    await zfs.promises.writeFile('/enc/persisted.txt', MARKER);
    umount('/enc');

    const second = await encryptedMount({ inner, getKey: () => key });
    mount('/enc', second);
    expect(await zfs.promises.readFile('/enc/persisted.txt', 'utf8')).toBe(MARKER);
    expect(zfs.readFileSync('/enc/persisted.txt', 'utf8')).toBe(MARKER); // preloaded mirror
  });

  it('mounting a non-empty tree without a key fails; an empty one mounts but writes fail', async () => {
    const key = await generateBlobKey();
    const locked = (): CryptoKey => {
      throw new PodLockedError('no usable key in this session');
    };

    const seeded = await resolveMountConfig({ backend: InMemory });
    const writer = await encryptedMount({ inner: seeded, getKey: () => key });
    await zfs.promises.mkdir('/enc');
    mount('/enc', writer);
    await zfs.promises.writeFile('/enc/secret.txt', MARKER);
    umount('/enc');
    await expect(encryptedMount({ inner: seeded, getKey: locked })).rejects.toThrow(/locked/);

    const empty = await resolveMountConfig({ backend: InMemory });
    const enc = await encryptedMount({ inner: empty, getKey: locked });
    mount('/enc', enc);
    await expect(zfs.promises.writeFile('/enc/nope.txt', 'x')).rejects.toThrow();
  });

  it('adopts pre-encryption plaintext files readably', async () => {
    const inner = await resolveMountConfig({ backend: InMemory });
    const legacy = new TextEncoder().encode('written before encryption');
    await inner.createFile('/legacy.txt', { uid: 0, gid: 0, mode: 0o644 });
    await inner.write('/legacy.txt', legacy, 0);
    await inner.touch('/legacy.txt', { size: legacy.length }); // what any direct writer's VFS would have done
    const enc = await encryptedMount({ inner, getKey: () => generateBlobKey() });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);
    expect(await zfs.promises.readFile('/enc/legacy.txt', 'utf8')).toBe('written before encryption');
  });
});
