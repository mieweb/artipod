/**
 * EncryptedFS — a ZenFS wrapper filesystem that stores every file's CONTENT
 * as chunked-AEAD ciphertext (src/oci/cipher.ts, the same at-rest format as
 * encrypted pod stores) on any inner backend (OPFS, IndexedDB, InMemory…).
 *
 * This closes the working-tree gap (serve plan S5.5 follow-up): overlay
 * uppers and scratch dirs persist in browser storage as ciphertext, keyed
 * by a callback that typically reads the session keyring — key evaporation
 * locks the tree (reads fail EACCES; mounting while locked fails).
 *
 * Honest scope: file CONTENTS are encrypted; names, directory structure,
 * timestamps and (ciphertext) sizes remain visible on the inner backend.
 * Plaintext exists only in the in-memory sync mirror (the ZenFS `Async`
 * mixin's cache — the same "plaintext only in memory caches" rule as
 * docs/encryption.md), never at rest.
 */
import type { CreationOptions, FileSystem as ZenFileSystem, InodeLike } from '@zenfs/core';
import { decryptBlob, encryptBlob, isEncryptedBlob } from '../oci/cipher.js';

export interface EncryptedFsOptions {
  /** Anything resolveMountConfig accepts (a backend config or a FileSystem). */
  inner: unknown;
  /**
   * The content key (AES-GCM). May throw (e.g. PodLockedError from a
   * keyring) — reads/writes then fail until the key returns.
   */
  getKey: () => CryptoKey | Promise<CryptoKey>;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

/** Inode fields safe to forward (never size — inner inodes bound CIPHERTEXT). */
const META_FIELDS = ['mode', 'flags', 'nlink', 'uid', 'gid', 'atimeMs', 'birthtimeMs', 'mtimeMs', 'ctimeMs', 'version'] as const;

/**
 * Detach an inode into a plain object. Backends hand out LIVE `Inode`
 * structs (Uint8Array views into the store) whose fields are prototype
 * accessors: spreading them yields byte soup, and the VFS Handle mutates
 * `inode.size` in place — leaking the live struct lets the PLAINTEXT size
 * be written straight into the inner store's inode record.
 */
function detach(inode: InodeLike): InodeLike {
  const maybe = inode as InodeLike & { toJSON?: () => InodeLike };
  return typeof maybe.toJSON === 'function' ? maybe.toJSON() : { ...inode };
}

type EncryptedFsCtor = new (inner: ZenFileSystem, getKey: EncryptedFsOptions['getKey']) => ZenFileSystem;
let classPromise: Promise<EncryptedFsCtor> | null = null;

/** Build the class lazily — @zenfs/core stays a dynamic import (bundle rule). */
async function encryptedFsClass(): Promise<EncryptedFsCtor> {
  classPromise ??= (async () => {
    const zen = await import('@zenfs/core');
    const { FileSystem, Async, InMemory } = zen;

    class EncryptedFSBase extends FileSystem {
      /** In-memory plaintext mirror for the Async mixin's sync surface. */
      _sync = InMemory.create({ label: 'artipod-encrypted-cache' });
      /** plaintext sizes (inner inodes carry ciphertext sizes). */
      private readonly sizes = new Map<string, number>();
      /** serializes read-modify-write cycles per path. */
      private readonly writeChains = new Map<string, Promise<void>>();

      constructor(
        readonly inner: ZenFileSystem,
        private readonly getKey: EncryptedFsOptions['getKey'],
      ) {
        super(0x0a70d3c2, 'artipod-encrypted');
      }

      async ready(): Promise<void> {
        await this.inner.ready();
        await super.ready();
      }

      private async key(): Promise<CryptoKey> {
        return this.getKey();
      }

      /** Whole-file read from the inner fs: ciphertext → plaintext.
       * Zero-byte and pre-encryption plaintext files pass through as-is. */
      private async readAll(path: string): Promise<Uint8Array> {
        const inode = await this.inner.stat(path);
        const raw = new Uint8Array(inode.size);
        if (inode.size > 0) await this.inner.read(path, raw, 0, inode.size);
        if (raw.length === 0 || !isEncryptedBlob(raw)) return raw;
        const plain = await decryptBlob(raw, await this.key());
        this.sizes.set(path, plain.length);
        return plain;
      }

      async stat(path: string): Promise<InodeLike> {
        const inode = detach(await this.inner.stat(path));
        if ((inode.mode & S_IFMT) === S_IFDIR) return inode;
        let size = this.sizes.get(path);
        size ??= (await this.readAll(path)).length;
        return { ...inode, size };
      }

      async read(path: string, buffer: Uint8Array, start: number, end: number): Promise<void> {
        const plain = await this.readAll(path);
        buffer.set(plain.subarray(start, end));
      }

      async write(path: string, buffer: Uint8Array, offset: number): Promise<void> {
        return this.chained(path, async () => {
          const current = await this.readAll(path);
          const next = new Uint8Array(Math.max(current.length, offset + buffer.length));
          next.set(current);
          next.set(buffer, offset);
          await this.writeWhole(path, next);
        });
      }

      /** Encrypt + replace the inner file, keeping the inner inode sized to the CIPHERTEXT. */
      private async writeWhole(path: string, plain: Uint8Array): Promise<void> {
        const { bytes } = await encryptBlob(plain, await this.key());
        await this.inner.write(path, bytes, 0);
        // store-backed inners never grow the inode on write — the VFS's own
        // touch normally does that, but it carries the PLAINTEXT size we strip
        await this.inner.touch(path, { size: bytes.length });
        this.sizes.set(path, plain.length);
      }

      /** Serialize mutations per path — interleaved read-modify-write loses updates. */
      private chained(path: string, job: () => Promise<void>): Promise<void> {
        const prev = this.writeChains.get(path) ?? Promise.resolve();
        const next = prev.then(job);
        this.writeChains.set(
          path,
          next.catch(() => {}),
        );
        return next;
      }

      async createFile(path: string, options: CreationOptions): Promise<InodeLike> {
        const inode = detach(await this.inner.createFile(path, options));
        this.sizes.set(path, 0);
        return { ...inode, size: 0 };
      }

      async touch(path: string, metadata: Partial<InodeLike>): Promise<void> {
        // explicit field pick: `metadata` can be a live struct (accessor
        // fields — rest-spread drops them), and plaintext size never crosses
        const meta: Partial<InodeLike> = {};
        for (const field of META_FIELDS) {
          const value = metadata[field];
          if (value !== undefined) (meta as Record<string, unknown>)[field] = value;
        }
        await this.inner.touch(path, meta);
        // a size CHANGE is a resize (O_TRUNC / ftruncate): re-encrypt the tree's truth
        const requested = metadata.size;
        if (requested === undefined) return;
        await this.chained(path, async () => {
          const plain = await this.readAll(path);
          if (plain.length === requested) return;
          const resized = new Uint8Array(requested);
          resized.set(plain.subarray(0, Math.min(plain.length, requested)));
          await this.writeWhole(path, resized);
        });
      }

      async rename(oldPath: string, newPath: string): Promise<void> {
        await this.inner.rename(oldPath, newPath);
        const size = this.sizes.get(oldPath);
        this.sizes.delete(oldPath);
        if (size !== undefined) this.sizes.set(newPath, size);
      }

      async unlink(path: string): Promise<void> {
        await this.inner.unlink(path);
        this.sizes.delete(path);
      }

      async link(target: string, link: string): Promise<void> {
        await this.inner.link(target, link);
        const size = this.sizes.get(target);
        if (size !== undefined) this.sizes.set(link, size);
      }

      async mkdir(path: string, options: CreationOptions): Promise<InodeLike> {
        return detach(await this.inner.mkdir(path, options));
      }

      async rmdir(path: string): Promise<void> {
        return this.inner.rmdir(path);
      }

      async readdir(path: string): Promise<string[]> {
        return this.inner.readdir(path);
      }

      async sync(): Promise<void> {
        await this.inner.sync();
      }

      // The Async mixin overrides every *Sync method with the in-memory
      // mirror; these bases are unreachable (WebCrypto has no sync form).
      private noSync(): never {
        throw new Error('EncryptedFS: synchronous access requires the Async mirror (mount via encryptedMount)');
      }
      renameSync(): void {
        this.noSync();
      }
      statSync(): InodeLike {
        this.noSync();
      }
      touchSync(): void {
        this.noSync();
      }
      createFileSync(): InodeLike {
        this.noSync();
      }
      unlinkSync(): void {
        this.noSync();
      }
      rmdirSync(): void {
        this.noSync();
      }
      mkdirSync(): InodeLike {
        this.noSync();
      }
      readdirSync(): string[] {
        this.noSync();
      }
      linkSync(): void {
        this.noSync();
      }
      syncSync(): void {
        this.noSync();
      }
      readSync(): void {
        this.noSync();
      }
      writeSync(): void {
        this.noSync();
      }
    }

    return Async(EncryptedFSBase) as unknown as EncryptedFsCtor;
  })();
  return classPromise;
}

/**
 * Resolve `inner` and wrap it: the returned FileSystem mounts anywhere a
 * ZenFS config does (overlay `upperConfig`, `mount(path, fs)`, …).
 * Mounting while the key is unavailable rejects — the preload mirror needs
 * to decrypt the tree.
 */
export async function encryptedMount(options: EncryptedFsOptions): Promise<ZenFileSystem> {
  const zen = await import('@zenfs/core');
  const inner =
    options.inner instanceof zen.FileSystem
      ? options.inner
      : await zen.resolveMountConfig(options.inner as Parameters<typeof zen.resolveMountConfig>[0]);
  const Ctor = await encryptedFsClass();
  const fs = new Ctor(inner, options.getKey);
  await fs.ready();
  return fs;
}
