/**
 * EncryptedStore — option B for working trees: instead of encrypting file
 * contents on a name-preserving backend (encrypted-fs.ts), the WHOLE
 * filesystem — names, directory entries, inodes, data — lives as ZenFS
 * StoreFS blocks keyed by inode number, and every block value encrypts on
 * the way to the inner store. The backing medium shows only opaque numbered
 * blocks: no filenames, no tree shape.
 *
 * Plaintext block values live in an in-memory cache (the same rule as every
 * other layer: plaintext only in memory), fully warmed at mount so the sync
 * surface works — a locked key therefore refuses the mount of a non-empty
 * store. Residual leaks: block count/sizes and write timing.
 */
import type { AsyncMap, FileSystem as ZenFileSystem, Store, Transaction, UsageInfo } from '@zenfs/core';
import { decryptBlob, encryptBlob, isEncryptedBlob } from '../oci/cipher.js';

type GetKey = () => CryptoKey | Promise<CryptoKey>;
type TxCtor = new (store: Store & AsyncMap) => Transaction;

/** Not every transaction kind implements commit (e.g. sync map stores). */
const commitIfAble = async (tx: Transaction): Promise<void> => {
  await (tx as { commit?: () => Promise<void> }).commit?.();
};

/** Where the ciphertext blocks live. */
export type EncryptedStoreBacking =
  | { kind: 'opfs'; dir: FileSystemDirectoryHandle }
  | { kind: 'config'; config: unknown }
  | { kind: 'store'; store: Store };

export interface EncryptedStoreMountOptions {
  backing: EncryptedStoreBacking;
  /** Block key (AES-GCM); may throw while locked. */
  getKey: GetKey;
}

class EncryptedStore implements Store, AsyncMap {
  readonly flags = [] as const;
  readonly name: string;
  /** plaintext block values — memory only, warmed at mount. */
  private readonly plain = new Map<number, Uint8Array>();
  private readonly ids = new Set<number>();

  constructor(
    private readonly inner: Store,
    private readonly getKey: GetKey,
    private readonly txCtor: TxCtor,
  ) {
    this.name = `encrypted:${inner.name}`;
  }

  /** Decrypt every existing block into the cache (locked key ⇒ throws). */
  async warm(): Promise<void> {
    const tx = this.inner.transaction();
    for (const id of await tx.keys()) {
      this.ids.add(id);
      const raw = await tx.get(id, 0);
      if (raw !== undefined) this.plain.set(id, await this.decode(raw));
    }
    await commitIfAble(tx);
  }

  private async decode(raw: Uint8Array): Promise<Uint8Array> {
    // zero-byte and pre-encryption blocks pass through (adoption)
    if (raw.length === 0 || !isEncryptedBlob(raw)) return raw;
    return decryptBlob(raw, await this.getKey());
  }

  keys(): Iterable<number> {
    return this.ids;
  }

  // Non-'partial' stores return the WHOLE value — StoreFS does the range
  // slicing itself (fs.js read: `tx.flag('partial') ? data : data.subarray`).
  // Always COPY out: StoreFS grows buffers via transfer(), which would
  // detach a shared backing (the IndexedDB backend copies for the same reason).
  cached(id: number): Uint8Array | undefined {
    return this.plain.get(id)?.slice();
  }

  async get(id: number): Promise<Uint8Array | undefined> {
    let value = this.plain.get(id);
    if (value === undefined) {
      const tx = this.inner.transaction();
      const raw = await tx.get(id, 0);
      await commitIfAble(tx);
      if (raw === undefined) return undefined;
      value = await this.decode(raw);
      this.plain.set(id, value);
      this.ids.add(id);
    }
    return value.slice();
  }

  async set(id: number, data: Uint8Array, offset = 0): Promise<void> {
    // non-'partial' stores REPLACE the whole value on set(id, data, 0) —
    // StoreFS pre-merges before calling us (keeping an old tail corrupts
    // shrunken dir listings). offset>0 is defensive only.
    let next: Uint8Array;
    if (offset === 0) {
      next = new Uint8Array(data); // snapshot — callers reuse/mutate buffers
    } else {
      const current = this.plain.get(id) ?? new Uint8Array();
      next = new Uint8Array(Math.max(current.length, offset + data.length));
      next.set(current);
      next.set(data, offset);
    }
    // cache updates SYNCHRONOUSLY (before any await): AsyncTransaction.setSync
    // fires this method and moves on — the next stat/read must already see it
    this.plain.set(id, next);
    this.ids.add(id);
    return this.enqueue(async () => {
      const { bytes } = await encryptBlob(next, await this.getKey());
      const tx = this.inner.transaction();
      await tx.set(id, bytes, 0);
      await commitIfAble(tx);
    });
  }

  async delete(id: number): Promise<void> {
    this.plain.delete(id);
    this.ids.delete(id);
    return this.enqueue(async () => {
      const tx = this.inner.transaction();
      await tx.remove(id);
      await commitIfAble(tx);
    });
  }

  /** Persistence keeps write order even when encryption times vary. */
  private queue = Promise.resolve();
  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.queue.then(job);
    this.queue = next.catch(() => {});
    return next;
  }

  async sync(): Promise<void> {
    await this.queue;
    return this.inner.sync();
  }

  transaction(): Transaction {
    return new this.txCtor(this);
  }

  usage(): UsageInfo {
    return this.inner.usage?.() ?? { totalSpace: 0, freeSpace: 0 };
  }
}

/** Ciphertext blocks as files named by id in an OPFS directory. */
class OpfsDirStore implements Store, AsyncMap {
  readonly flags = [] as const;
  readonly name = 'opfs-blocks';

  private constructor(
    private readonly dir: FileSystemDirectoryHandle,
    private readonly known: Set<number>,
    private readonly txCtor: TxCtor,
  ) {}

  static async open(dir: FileSystemDirectoryHandle, txCtor: TxCtor): Promise<OpfsDirStore> {
    const known = new Set<number>();
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      const id = Number(name);
      if (Number.isInteger(id)) known.add(id);
    }
    return new OpfsDirStore(dir, known, txCtor);
  }

  keys(): Iterable<number> {
    return this.known;
  }

  /** Ciphertext is never served synchronously — EncryptedStore above holds the plaintext cache. */
  cached(): Uint8Array | undefined {
    return undefined;
  }

  async get(id: number): Promise<Uint8Array | undefined> {
    try {
      const handle = await this.dir.getFileHandle(String(id));
      return new Uint8Array(await (await handle.getFile()).arrayBuffer());
    } catch {
      return undefined;
    }
  }

  async set(id: number, data: Uint8Array, offset = 0): Promise<void> {
    let whole = data;
    if (offset !== 0) {
      const current = (await this.get(id)) ?? new Uint8Array();
      whole = new Uint8Array(Math.max(current.length, offset + data.length));
      whole.set(current);
      whole.set(data, offset);
    }
    const handle = await this.dir.getFileHandle(String(id), { create: true });
    const writable = await handle.createWritable();
    await writable.write(whole as unknown as ArrayBufferView<ArrayBuffer>);
    await writable.close();
    this.known.add(id);
  }

  async delete(id: number): Promise<void> {
    await this.dir.removeEntry(String(id)).catch(() => {});
    this.known.delete(id);
  }

  sync(): Promise<void> {
    return Promise.resolve();
  }

  transaction(): Transaction {
    return new this.txCtor(this);
  }
}

/**
 * Mount point for option B: resolve the backing to a `Store`, wrap it in
 * EncryptedStore, and serve it through a fresh StoreFS. `config` backings
 * must resolve to a store-based filesystem (InMemory, IndexedDB — not
 * WebAccess; use the `opfs` backing for OPFS block dirs).
 */
export async function encryptedStoreMount(options: EncryptedStoreMountOptions): Promise<ZenFileSystem> {
  const zen = await import('@zenfs/core');
  const txCtor = zen.AsyncMapTransaction as unknown as TxCtor;
  let inner: Store;
  const backing = options.backing;
  if (backing.kind === 'opfs') {
    inner = await OpfsDirStore.open(backing.dir, txCtor);
  } else if (backing.kind === 'store') {
    inner = backing.store;
  } else {
    const resolved = await zen.resolveMountConfig(backing.config as Parameters<typeof zen.resolveMountConfig>[0]);
    if (!(resolved instanceof zen.StoreFS)) {
      throw new Error(`encryptedStoreMount: '${resolved.name}' is not store-backed — pass an InMemory/IndexedDB config or an opfs backing`);
    }
    inner = (resolved as unknown as { store: Store }).store;
  }
  const store = new EncryptedStore(inner, options.getKey, txCtor);
  await store.warm();
  const fs = new zen.StoreFS(store);
  await fs.ready();
  return fs;
}
