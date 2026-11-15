/**
 * EncryptedStore (option B): the whole filesystem — names, dirs, inodes,
 * data — lands as encrypted numbered blocks; the backing shows no filenames
 * and no tree shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, InMemory, InMemoryStore, fs as zfs, mount, umount, mounts as zenMounts } from '@zenfs/core';
import { generateBlobKey, isEncryptedBlob } from '../oci/cipher.js';
import { PodLockedError } from '../manager/keyring.js';
import { encryptedStoreMount } from './encrypted-store.js';

const MARKER = 'PHI-marker: block-store payload';
const NAME = 'very-secret-filename.md';

/** Raw OPFS test double: inspect every backing write, including intermediates. */
class TestOpfsDirectory {
  readonly files = new Map<string, Uint8Array>();
  readonly writes: Uint8Array[] = [];
  readError?: Error;
  deleteError?: Error;
  writeError?: Error;
  closeError?: Error;
  aborts = 0;
  writeGate?: Promise<void>;
  writeStarted?: () => void;

  async *keys(): AsyncIterable<string> { yield* this.files.keys(); }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException('missing file', 'NotFoundError');
      this.files.set(name, new Uint8Array());
    }
    return {
      move: async (_destination: FileSystemDirectoryHandle, nextName: string) => {
        const bytes = this.files.get(name)!;
        this.files.set(nextName, bytes);
        this.files.delete(name);
      },
      getFile: async () => {
        if (this.readError) throw this.readError;
        return { arrayBuffer: async () => this.files.get(name)!.slice().buffer };
      },
      createWritable: async () => {
        let pending = new Uint8Array();
        return {
          write: async (bytes: Uint8Array) => {
            pending = bytes.slice();
            this.writes.push(pending);
            this.writeStarted?.();
            await this.writeGate;
            if (this.writeError) throw this.writeError;
          },
          close: async () => {
            if (this.closeError) throw this.closeError;
            this.files.set(name, pending);
          },
          abort: async () => { this.aborts++; },
        };
      },
    };
  }

  async removeEntry(name: string): Promise<void> {
    if (this.deleteError) throw this.deleteError;
    if (!this.files.delete(name)) throw new DOMException('missing file', 'NotFoundError');
  }

  get handle(): FileSystemDirectoryHandle { return this as unknown as FileSystemDirectoryHandle; }
}

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

  it('strict backings reject plaintext and empty legacy blocks', async () => {
    const key = await generateBlobKey();
    for (const raw of [new TextEncoder().encode(NAME), new Uint8Array()]) {
      const inner = new InMemoryStore();
      inner.set(0, raw);
      await expect(encryptedStoreMount({
        backing: { kind: 'store', store: inner }, getKey: () => key, strictCiphertext: true,
      })).rejects.toThrow('plaintext backing block refused');
      expect(inner.get(0)).toBe(raw);
    }
  });

  it('strict OPFS encrypts every write from root initialization onward and remounts', async () => {
    const key = await generateBlobKey();
    const dir = new TestOpfsDirectory();
    const enc = await encryptedStoreMount({
      backing: { kind: 'opfs', dir: dir.handle }, getKey: () => key, strictCiphertext: true,
    });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);
    await zfs.promises.mkdir('/enc/private-directory-name');
    await zfs.promises.writeFile(`/enc/private-directory-name/${NAME}`, MARKER);
    await enc.flush();
    expect(dir.writes.length).toBeGreaterThan(0);
    for (const bytes of dir.writes) {
      expect(isEncryptedBlob(bytes)).toBe(true);
      const text = new TextDecoder().decode(bytes);
      expect(text).not.toContain(NAME);
      expect(text).not.toContain('private-directory-name');
      expect(text).not.toContain(MARKER);
    }
    expect([...dir.files.keys()].every(name => /^\d+$/.test(name))).toBe(true);
    umount('/enc');
    const reopened = await encryptedStoreMount({
      backing: { kind: 'opfs', dir: dir.handle }, getKey: () => key, strictCiphertext: true,
    });
    mount('/enc', reopened);
    expect(await zfs.promises.readFile(`/enc/private-directory-name/${NAME}`, 'utf8')).toBe(MARKER);
  });

  it('strict OPFS refuses unexpected named files instead of silently ignoring them', async () => {
    const dir = new TestOpfsDirectory();
    dir.files.set(NAME, new TextEncoder().encode(MARKER));
    await expect(encryptedStoreMount({
      backing: { kind: 'opfs', dir: dir.handle }, getKey: generateBlobKey, strictCiphertext: true,
    })).rejects.toThrow('unexpected plaintext backing entry refused');
    expect(dir.writes).toHaveLength(0);
  });

  it('checks live access before cached content, metadata, existing handles and writes', async () => {
    const key = await generateBlobKey();
    const inner = new InMemoryStore();
    let unlocked = true;
    const assertAccess = () => { if (!unlocked) throw new PodLockedError('lease expired'); };
    const enc = await encryptedStoreMount({
      backing: { kind: 'store', store: inner }, getKey: () => key,
      strictCiphertext: true, assertAccess,
    });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);
    await zfs.promises.writeFile(`/enc/${NAME}`, MARKER);
    const handle = await zfs.promises.open(`/enc/${NAME}`, 'r+');
    expect(zfs.readFileSync(`/enc/${NAME}`, 'utf8')).toBe(MARKER);
    await enc.flush();
    const before = new Map([...inner].map(([id, bytes]) => [id, bytes.slice()]));
    unlocked = false;
    expect(() => zfs.readFileSync(`/enc/${NAME}`, 'utf8')).toThrow('EACCES');
    expect(() => zfs.statSync(`/enc/${NAME}`)).toThrow('EACCES');
    expect(() => zfs.readdirSync('/enc')).toThrow('EACCES');
    expect(() => enc.existsSync(`/${NAME}`)).toThrow('lease expired');
    expect(() => zfs.writeFileSync('/enc/blocked.txt', 'blocked')).toThrow('EACCES');
    await expect(zfs.promises.readdir('/enc')).rejects.toThrow('EACCES');
    await expect(handle.read(new Uint8Array(1), 0, 1, 0)).rejects.toThrow('EACCES');
    await expect(handle.write('blocked')).rejects.toThrow('EACCES');
    await expect(enc.flush()).rejects.toThrow('lease expired');
    expect(new Map(inner)).toEqual(before);
    expect(() => umount('/enc')).not.toThrow();
    unlocked = true;
    await handle.close();
  });

  it('refuses a fresh mount when its synchronous access check is locked', async () => {
    const inner = new InMemoryStore();
    await expect(encryptedStoreMount({
      backing: { kind: 'store', store: inner }, getKey: generateBlobKey,
      assertAccess: () => { throw new PodLockedError('lease required'); }, strictCiphertext: true,
    })).rejects.toThrow('lease required');
    expect(inner.size).toBe(0);
  });

  it('rejects an asynchronous access check instead of bypassing its rejection', async () => {
    const inner = new InMemoryStore();
    await expect(encryptedStoreMount({
      backing: { kind: 'store', store: inner }, getKey: generateBlobKey,
      assertAccess: async () => { throw new PodLockedError('lease required'); }, strictCiphertext: true,
    })).rejects.toThrow('assertAccess must be synchronous');
    expect(inner.size).toBe(0);
  });

  it('flush waits for synchronous writes whose encryption has not completed', async () => {
    const key = await generateBlobKey();
    const inner = new InMemoryStore();
    let gated = false;
    let release!: (key: CryptoKey) => void;
    let started!: () => void;
    const gate = new Promise<CryptoKey>(resolve => { release = resolve; });
    const encryptionStarted = new Promise<void>(resolve => { started = resolve; });
    const getKey = () => { if (!gated) return key; started(); return gate; };
    const enc = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);
    gated = true;
    zfs.writeFileSync(`/enc/${NAME}`, MARKER);
    let flushed = false;
    const pending = enc.flush().then(() => { flushed = true; });
    await encryptionStarted;
    expect(flushed).toBe(false);
    expect(() => enc.syncSync()).toThrow('persistence is pending');
    release(key);
    await pending;
    expect(flushed).toBe(true);
    umount('/enc');
    const reopened = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey: () => key, strictCiphertext: true });
    mount('/enc', reopened);
    expect(await zfs.promises.readFile(`/enc/${NAME}`, 'utf8')).toBe(MARKER);
  });

  it('retains queued encryption failures so later flush/sync cannot report success', async () => {
    const key = await generateBlobKey();
    const inner = new InMemoryStore();
    let failing = false;
    const getKey = () => { if (failing) throw new PodLockedError('key lost before encryption'); return key; };
    const enc = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);
    failing = true;
    zfs.writeFileSync('/enc/pending.txt', MARKER);
    await expect(enc.flush()).rejects.toThrow('key lost before encryption');
    failing = false;
    await expect(enc.flush()).rejects.toThrow('key lost before encryption');
    await expect(enc.sync()).rejects.toThrow('key lost before encryption');
    expect(() => enc.syncSync()).toThrow('key lost before encryption');
    await expect(zfs.promises.writeFile('/enc/later.txt', 'later')).rejects.toThrow();
    umount('/enc');
    const reopened = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey: () => key });
    mount('/enc', reopened);
    expect(await zfs.promises.readdir('/enc')).toEqual([]);
  });

  it('drains in-flight backing I/O before a locked flush rejects', async () => {
    const key = await generateBlobKey();
    const dir = new TestOpfsDirectory();
    let unlocked = true;
    const enc = await encryptedStoreMount({
      backing: { kind: 'opfs', dir: dir.handle }, getKey: () => key,
      assertAccess: () => { if (!unlocked) throw new PodLockedError('lease expired'); },
    });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);
    let release!: () => void;
    let started!: () => void;
    dir.writeGate = new Promise<void>(resolve => { release = resolve; });
    const backingWriteStarted = new Promise<void>(resolve => { started = resolve; });
    dir.writeStarted = started;
    zfs.writeFileSync('/enc/pending.txt', MARKER);
    await backingWriteStarted;
    unlocked = false;
    let settled = false;
    const flushing = enc.flush().then(() => null, error => error).finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await flushing).toMatchObject({ code: 'EACCES' });
    expect(settled).toBe(true);
    const commits = [...dir.files].map(([name, bytes]) => [name, bytes.slice()]);
    await Promise.resolve();
    expect([...dir.files]).toEqual(commits);
    expect(() => umount('/enc')).not.toThrow();
  });

  it('drains queued initialization work before a failed mount returns without a handle', async () => {
    const key = await generateBlobKey();
    const inner = new InMemoryStore();
    let keyRequested = false;
    let release!: (key: CryptoKey) => void;
    let started!: () => void;
    const keyGate = new Promise<CryptoKey>(resolve => { release = resolve; });
    const encryptionStarted = new Promise<void>(resolve => { started = resolve; });
    let settled = false;
    const opening = encryptedStoreMount({
      backing: { kind: 'store', store: inner }, strictCiphertext: true,
      getKey: () => { keyRequested = true; started(); return keyGate; },
      assertAccess: () => { if (keyRequested) throw new Error('lease lost during initialization'); },
    }).then(() => null, error => error).finally(() => { settled = true; });
    await encryptionStarted;
    // ready has encountered the revoked lease, but its earlier queued work
    // must settle before callers can release their external writer lock.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release(key);
    expect(await opening).toMatchObject({ code: 'EACCES' });
    expect(inner.size).toBe(0);
  });

  it('retains backing write and sync failures', async () => {
    const key = await generateBlobKey();
    const inner = new InMemoryStore();
    const enc = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey: () => key });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);
    const write = vi.spyOn(inner, 'set').mockImplementation(() => { throw new DOMException('quota exhausted', 'QuotaExceededError'); });
    zfs.writeFileSync('/enc/unsaved.txt', MARKER);
    await expect(enc.flush()).rejects.toThrow('quota exhausted');
    write.mockRestore();
    await expect(enc.flush()).rejects.toThrow('quota exhausted');

    umount('/enc');
    const fresh = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey: () => key });
    const sync = vi.spyOn(inner, 'sync').mockRejectedValue(new Error('durability failed'));
    await expect(fresh.flush()).rejects.toThrow('durability failed');
    sync.mockRestore();
    await expect(fresh.flush()).rejects.toThrow('durability failed');
  });

  it('propagates OPFS read failures instead of treating unreadable data as absent', async () => {
    const key = await generateBlobKey();
    const dir = new TestOpfsDirectory();
    await encryptedStoreMount({ backing: { kind: 'opfs', dir: dir.handle }, getKey: () => key });
    dir.readError = new DOMException('permission revoked', 'NotAllowedError');
    const writes = dir.writes.length;
    await expect(encryptedStoreMount({
      backing: { kind: 'opfs', dir: dir.handle }, getKey: () => key, strictCiphertext: true,
    })).rejects.toThrow('permission revoked');
    expect(dir.writes).toHaveLength(writes);
  });

  it.each(['write', 'close'] as const)('aborts an OPFS stream after a %s failure without replacing prior ciphertext', async (operation) => {
    const key = await generateBlobKey();
    const dir = new TestOpfsDirectory();
    const enc = await encryptedStoreMount({ backing: { kind: 'opfs', dir: dir.handle }, getKey: () => key });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);
    await zfs.promises.writeFile('/enc/original.txt', MARKER);
    await enc.flush();
    const original = new Map([...dir.files].map(([id, bytes]) => [id, bytes.slice()]));
    const error = new DOMException(`${operation} failed`, 'QuotaExceededError');
    if (operation === 'write') dir.writeError = error;
    else dir.closeError = error;
    zfs.writeFileSync('/enc/original.txt', 'unsaved replacement');
    await expect(enc.flush()).rejects.toThrow(`${operation} failed`);
    expect(dir.aborts).toBe(1);
    expect(dir.files).toEqual(original);
  });

  it('propagates OPFS deletion failures and keeps flush failed', async () => {
    const key = await generateBlobKey();
    const dir = new TestOpfsDirectory();
    const enc = await encryptedStoreMount({ backing: { kind: 'opfs', dir: dir.handle }, getKey: () => key });
    await zfs.promises.mkdir('/enc');
    mount('/enc', enc);
    await zfs.promises.writeFile('/enc/delete-me.txt', MARKER);
    dir.deleteError = new DOMException('delete permission revoked', 'NotAllowedError');
    await expect(zfs.promises.unlink('/enc/delete-me.txt')).rejects.toThrow();
    await expect(enc.flush()).rejects.toThrow('delete permission revoked');
  });
});
