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
  /** Reject legacy plaintext blocks instead of adopting them. Default false. */
  strictCiphertext?: boolean;
  /**
   * Synchronous lease/access check, including cached reads and metadata.
   * Throw while locked. This must not return a promise.
   */
  assertAccess?: () => void;
}

export interface EncryptedStoreFileSystem extends ZenFileSystem {
  /** Await queued encryption and backing I/O; rejects after any persistence failure. */
  flush(): Promise<void>;
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
    private readonly options: Pick<EncryptedStoreMountOptions, 'strictCiphertext' | 'assertAccess'>,
  ) {
    this.name = `encrypted:${inner.name}`;
  }

  /** Decrypt every existing block into the cache (locked key ⇒ throws). */
  async warm(): Promise<void> {
    this.assertAccess();
    const tx = this.inner.transaction();
    for (const id of await tx.keys()) {
      if (this.options.strictCiphertext && (!Number.isSafeInteger(id) || id < 0)) {
        throw new Error('EncryptedStore: invalid backing block identifier');
      }
      this.ids.add(id);
      const raw = await tx.get(id, 0);
      if (raw === undefined && this.options.strictCiphertext) throw new Error('EncryptedStore: backing block disappeared while opening');
      if (raw !== undefined) this.plain.set(id, await this.decode(raw));
    }
    await commitIfAble(tx);
  }

  private async decode(raw: Uint8Array): Promise<Uint8Array> {
    this.assertAccess();
    // zero-byte and pre-encryption blocks pass through (adoption)
    if (!isEncryptedBlob(raw)) {
      if (this.options.strictCiphertext) throw new Error('EncryptedStore: plaintext backing block refused');
      return raw;
    }
    return decryptBlob(raw, await this.getKey());
  }

  keys(): Iterable<number> {
    this.assertAccess();
    return this.ids;
  }

  // Non-'partial' stores return the WHOLE value — StoreFS does the range
  // slicing itself (fs.js read: `tx.flag('partial') ? data : data.subarray`).
  // Always COPY out: StoreFS grows buffers via transfer(), which would
  // detach a shared backing (the IndexedDB backend copies for the same reason).
  cached(id: number): Uint8Array | undefined {
    this.assertAccess();
    return this.plain.get(id)?.slice();
  }

  async get(id: number): Promise<Uint8Array | undefined> {
    this.assertAccess();
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

  set(id: number, data: Uint8Array, offset = 0): Promise<void> {
    this.assertWritable();
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
      this.assertAccess();
      const tx = this.inner.transaction();
      await tx.set(id, bytes, 0);
      await commitIfAble(tx);
    });
  }

  delete(id: number): Promise<void> {
    this.assertWritable();
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
  private pending = 0;
  private failed = false;
  private failure: unknown;

  assertAccess(): void {
    this.options.assertAccess?.();
  }

  private assertWritable(): void {
    this.assertAccess();
    if (this.failed) throw this.failure;
  }

  private rememberFailure(error: unknown): void {
    if (!this.failed) {
      this.failed = true;
      this.failure = error;
    }
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.pending++;
    const next = this.queue.then(async () => {
      this.assertWritable();
      await job();
    });
    // Synchronous ZenFS transactions cannot await persistence. Keep their
    // rejections handled, but retain the first failure for every later flush.
    this.queue = next.catch((error: unknown) => this.rememberFailure(error)).finally(() => { this.pending--; });
    return next;
  }

  async sync(): Promise<void> {
    // Drain even while locked: a caller closing the mount must not release
    // its writer lock while an earlier backing write is still in flight.
    let tail: Promise<void>;
    do {
      tail = this.queue;
      await tail;
    } while (tail !== this.queue);
    this.assertWritable();
    try {
      await this.inner.sync();
    } catch (error) {
      this.rememberFailure(error);
      throw error;
    }
  }

  syncSync(): void {
    this.assertWritable();
    if (this.pending) throw new Error('EAGAIN: encrypted persistence is pending; await flush()');
  }

  transaction(): Transaction {
    this.assertAccess();
    const tx = new this.txCtor(this);
    // AsyncMapTransaction defers setSync/removeSync past an await. Update
    // our cache and enqueue immediately, so flush cannot miss these writes.
    tx.setSync = (id, data, offset = 0) => { void this.set(id, data, offset); };
    tx.removeSync = (id) => { void this.delete(id); };
    return tx;
  }

  usage(): UsageInfo {
    this.assertAccess();
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

  static async open(dir: FileSystemDirectoryHandle, txCtor: TxCtor, strict = false): Promise<OpfsDirStore> {
    const known = new Set<number>();
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      const id = Number(name);
      if (strict && (!/^(0|[1-9]\d*)$/.test(name) || !Number.isSafeInteger(id))) {
        throw new Error('EncryptedStore: unexpected plaintext backing entry refused');
      }
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
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
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
    try {
      await writable.write(whole as unknown as ArrayBufferView<ArrayBuffer>);
      await writable.close();
    } catch (error) {
      // Release the stream's backing-file lock without replacing a previous
      // valid ciphertext block. Keep the initiating write/close error.
      await writable.abort().catch(() => {});
      throw error;
    }
    this.known.add(id);
  }

  async delete(id: number): Promise<void> {
    try {
      await this.dir.removeEntry(String(id));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.known.delete(id);
  }

  sync(): Promise<void> {
    return Promise.resolve();
  }

  transaction(): Transaction {
    return new this.txCtor(this);
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'NotFoundError';
}

/** Guard the FS surface too: StoreFS can answer from its own inode tables. */
function guardAccess(fs: ZenFileSystem, assertAccess: () => void): void {
  const methods = [
    'ready', 'usage', 'loadIndex', 'loadIndexSync', 'createIndex', 'createIndexSync',
    'rename', 'renameSync', 'stat', 'statSync', 'touch', 'touchSync',
    'createFile', 'createFileSync', 'unlink', 'unlinkSync', 'rmdir', 'rmdirSync',
    'mkdir', 'mkdirSync', 'readdir', 'readdirSync', 'exists', 'existsSync',
    'link', 'linkSync', 'read', 'readSync', 'write', 'writeSync',
    'streamRead', 'streamWrite', 'transaction', 'checkRoot', 'checkRootSync',
  ];
  const target = fs as unknown as Record<string, unknown>;
  for (const name of methods) {
    const method = target[name];
    if (typeof method !== 'function') continue;
    Object.defineProperty(fs, name, {
      configurable: true,
      value: function (this: ZenFileSystem, ...args: unknown[]) {
        assertAccess();
        return Reflect.apply(method, this, args);
      },
    });
  }
}

/**
 * Mount point for option B: resolve the backing to a `Store`, wrap it in
 * EncryptedStore, and serve it through a fresh StoreFS. `config` backings
 * must resolve to a store-based filesystem (InMemory, IndexedDB — not
 * WebAccess; use the `opfs` backing for OPFS block dirs).
 */
export async function encryptedStoreMount(options: EncryptedStoreMountOptions): Promise<EncryptedStoreFileSystem> {
  const zen = await import('@zenfs/core');
  // Normalize callback failures to filesystem access errors, including when
  // a caller throws an ordinary Error without a POSIX code.
  const assertAccess = options.assertAccess ? () => {
    try {
      const result: unknown = options.assertAccess!();
      if (result && typeof result === 'object' && 'then' in result) {
        void Promise.resolve(result).catch(() => {});
        throw new Error('EncryptedStore: assertAccess must be synchronous');
      }
    } catch (error) {
      if (error instanceof zen.ErrnoError) throw error;
      throw new zen.ErrnoError(
        13 as ConstructorParameters<typeof zen.ErrnoError>[0],
        error instanceof Error ? error.message : 'Encrypted filesystem is locked',
      );
    }
  } : undefined;
  assertAccess?.();
  const txCtor = zen.AsyncMapTransaction as unknown as TxCtor;
  let inner: Store;
  const backing = options.backing;
  if (backing.kind === 'opfs') {
    inner = await OpfsDirStore.open(backing.dir, txCtor, options.strictCiphertext);
  } else if (backing.kind === 'store') {
    inner = backing.store;
  } else {
    const resolved = await zen.resolveMountConfig(backing.config as Parameters<typeof zen.resolveMountConfig>[0]);
    if (!(resolved instanceof zen.StoreFS)) {
      throw new Error(`encryptedStoreMount: '${resolved.name}' is not store-backed — pass an InMemory/IndexedDB config or an opfs backing`);
    }
    inner = (resolved as unknown as { store: Store }).store;
  }
  const store = new EncryptedStore(inner, options.getKey, txCtor, { ...options, assertAccess });
  await store.warm();
  class EncryptedFileSystem extends zen.StoreFS {
    flush(): Promise<void> { return store.sync(); }
    override sync(): Promise<void> { return this.flush(); }
    override syncSync(): void { store.syncSync(); }
  }
  const fs = new EncryptedFileSystem(store);
  if (assertAccess) guardAccess(fs, assertAccess);
  try {
    await fs.ready();
    await fs.flush();
    return fs;
  } catch (error) {
    // Initialization can queue synchronous root writes before ready rejects.
    // Callers never received this filesystem, so drain here before they
    // release ownership or remove a failed generation.
    try { await store.sync(); } catch { /* Preserve the opening error. */ }
    throw error;
  }
}
