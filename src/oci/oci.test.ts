/**
 * OCI unit tests: tar indexer (ustar/PAX/whiteouts), digests, gzip, cipher
 * round-trip + tamper rejection, blob store immutability + verification.
 * All fixtures are crafted in-test — no network, no docker.
 */
import { describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { sha256, verifyDigest, isDigest } from './digest.js';
import { gunzip, isGzip } from './gzip.js';
import { indexTar, whiteoutTarget } from './tar.js';
import { decryptBlob, encryptBlob, generateBlobKey, isEncryptedBlob } from './cipher.js';
import { OciStore } from './store.js';
import { makeTar, gzipBytes } from './test-fixtures.js';

const text = (s: string) => new TextEncoder().encode(s);

describe('digest', () => {
  it('hashes and verifies; tampering is refused', async () => {
    const digest = await sha256(text('hello'));
    expect(isDigest(digest)).toBe(true);
    await verifyDigest(text('hello'), digest);
    await expect(verifyDigest(text('hell0'), digest)).rejects.toThrow(/tampered/);
  });
});

describe('gzip', () => {
  it('round-trips through CompressionStream and detects magic', async () => {
    const raw = text('artipod '.repeat(1000));
    const zipped = await gzipBytes(raw);
    expect(isGzip(zipped)).toBe(true);
    expect(isGzip(raw)).toBe(false);
    expect(await gunzip(zipped)).toEqual(raw);
  });
});

describe('tar indexer', () => {
  it('indexes files, dirs, symlinks, hardlinks with correct offsets', async () => {
    const tar = makeTar([
      { path: 'etc/', type: 'dir' },
      { path: 'etc/os-release', content: 'NAME=artipod\n' },
      { path: 'bin/busybox', content: 'ELFBUSYBOX' },
      { path: 'bin/sh', type: 'hardlink', linkTarget: 'bin/busybox' },
      { path: 'etc/alias', type: 'symlink', linkTarget: 'os-release' },
    ]);
    const entries = indexTar(tar);
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.get('/etc')?.type).toBe('dir');
    const os = byPath.get('/etc/os-release')!;
    expect(os.type).toBe('file');
    expect(new TextDecoder().decode(tar.subarray(os.offset, os.offset + os.size))).toBe('NAME=artipod\n');
    expect(byPath.get('/bin/sh')).toMatchObject({ type: 'hardlink', linkTarget: '/bin/busybox' });
    expect(byPath.get('/etc/alias')).toMatchObject({ type: 'symlink', linkTarget: 'os-release' });
  });

  it('handles PAX long paths', () => {
    const longPath = `deep/${'x'.repeat(120)}/name.txt`;
    const tar = makeTar([{ path: longPath, content: 'long', pax: true }]);
    const entries = indexTar(tar);
    expect(entries.find((e) => e.path === `/${longPath}`)).toMatchObject({ type: 'file', size: 4 });
  });

  it('recognizes whiteout markers', () => {
    expect(whiteoutTarget('/app/.wh.config.json')).toEqual({ kind: 'delete', target: '/app/config.json' });
    expect(whiteoutTarget('/app/.wh..wh..opq')).toEqual({ kind: 'opaque', dir: '/app' });
    expect(whiteoutTarget('/app/regular.txt')).toBeNull();
  });
});

describe('cipher (chunked AES-256-GCM)', () => {
  it('round-trips with dual digests; tampering fails authentication', async () => {
    const key = await generateBlobKey();
    const plaintext = crypto.getRandomValues(new Uint8Array(3 * 1024 + 17));
    const encrypted = await encryptBlob(plaintext, key, 1024); // multiple chunks
    expect(isEncryptedBlob(encrypted.bytes)).toBe(true);
    expect(encrypted.plaintextDigest).not.toBe(encrypted.ciphertextDigest);

    const decrypted = await decryptBlob(encrypted.bytes, key, encrypted.plaintextDigest);
    expect(decrypted).toEqual(plaintext);

    const tampered = encrypted.bytes.slice();
    tampered[tampered.length - 5] ^= 0xff;
    await expect(decryptBlob(tampered, key)).rejects.toThrow(/tampered|authentication/);
  });
});

describe('OciStore', () => {
  async function freshStore(): Promise<OciStore> {
    try {
      umount('/');
    } catch {
      // first
    }
    await configure({ mounts: { '/': InMemory } });
    const store = new OciStore(zfs);
    await store.init();
    return store;
  }

  it('stores blobs immutably, verifies on read, rejects tampered writes', async () => {
    const store = await freshStore();
    const bytes = text('layer data');
    const digest = await store.putBlob(bytes);
    expect(await store.hasBlob(digest)).toBe(true);
    expect(await store.getBlob(digest)).toEqual(bytes);

    const wrong = await sha256(text('other'));
    await expect(store.putBlob(bytes, wrong)).rejects.toThrow(/mismatch/);

    // corrupt the stored file → read refuses
    await zfs.promises.writeFile(`/.artipod/oci/blobs/sha256/${digest.slice(7)}`, text('corrupted'));
    await expect(store.getBlob(digest)).rejects.toThrow(/tampered/);
  });

  it('persists refs + superblock across store re-instantiation (reload survival)', async () => {
    const store = await freshStore();
    const digest = await store.putBlob(text('manifest'));
    await store.putRef('docker.io/library/alpine:3.22', digest, 'application/vnd.oci.image.manifest.v1+json');
    const podId = store.getSuperblock().podId;

    // same zfs, new store instance = page reload
    const reloaded = new OciStore(zfs);
    await reloaded.init();
    expect(reloaded.getSuperblock().podId).toBe(podId);
    expect(await reloaded.getBlob(digest)).toEqual(text('manifest'));
    const refs = await reloaded.listRefs();
    expect(refs.map((r) => r.ref)).toEqual(['docker.io/library/alpine:3.22']);
  });

  it('encrypted pods store ciphertext yet stay plaintext-addressed', async () => {
    const store = await freshStore();
    await store.enableEncryption(await generateBlobKey());
    expect(store.getSuperblock().cipher).toBe('aes-256-gcm-chunked');

    const bytes = text('secret layer');
    const digest = await store.putBlob(bytes);
    expect(await store.getBlob(digest)).toEqual(bytes);

    // on disk: no plaintext under the plaintext digest, alias + ciphertext instead
    const names = (await zfs.promises.readdir('/.artipod/oci/blobs/sha256')) as string[];
    expect(names).toContain(`${digest.slice(7)}.alias`);
    expect(names).not.toContain(digest.slice(7));
    for (const name of names.filter((n) => !n.endsWith('.alias'))) {
      const raw = (await zfs.promises.readFile(`/.artipod/oci/blobs/sha256/${name}`)) as Uint8Array;
      expect(isEncryptedBlob(raw)).toBe(true);
      expect(new TextDecoder().decode(raw)).not.toContain('secret layer');
    }
  });
});
