/**
 * The browser's private filesystem, including its catalog and OCI metadata.
 * Only an opaque bootstrap record lives outside the encrypted block store.
 * Legacy stores are read without mounting/initializing them, verified, and
 * removed only after an encrypted generation has been durably committed.
 */
import type { AsyncMap, FileSystem, InodeLike, Store, Transaction, UsageInfo } from '@zenfs/core';
import { sha256 } from '../oci/digest.js';
import { decryptBlob, isEncryptedBlob } from '../oci/cipher.js';
import { encryptedStoreMount, type EncryptedStoreBacking, type EncryptedStoreFileSystem } from './encrypted-store.js';

export type BrowserVaultBackend = 'opfs' | 'indexeddb';
export interface BrowserVaultControl {
  formatVersion: 1;
  cipher: 'aes-256-gcm-chunked';
  encryptionRequired: true;
  backend: BrowserVaultBackend;
  generation: string | null;
  phase: 'pending' | 'copying' | 'cleanup' | 'ready';
}
export type BrowserVaultSourceFilesystem = Pick<FileSystem, 'stat' | 'readdir' | 'read'>;
export interface BrowserVaultLegacySource {
  /** Stable source identity. It is written only inside the encrypted journal. */
  id: string;
  filesystem: BrowserVaultSourceFilesystem;
  /** Logical destination, normally / or /.artipod/uppers/<legacy suffix>. */
  target: string;
  cleanup(): Promise<void>;
}
type VaultBacking = Exclude<EncryptedStoreBacking, { kind: 'config' }>;
export interface BrowserVaultAdapters {
  backend: BrowserVaultBackend;
  /** Must reject storage errors; null means definitive absence. */
  readControl(): Promise<BrowserVaultControl | null>;
  /** Atomic, durable replacement (the browser adapter uses an IDB transaction). */
  writeControl(control: BrowserVaultControl): Promise<void>;
  acquireWriter(): Promise<() => void>;
  generation(id: string, mode: 'create' | 'open'): Promise<VaultBacking>;
  removeGeneration(id: string): Promise<void>;
  legacySources(): Promise<BrowserVaultLegacySource[]>;
}
export interface BrowserVault {
  filesystem: EncryptedStoreFileSystem;
  encrypted: true;
  backend: BrowserVaultBackend;
  generation: string;
  /** Authenticate a renewed key object before allowing cached access or writes. */
  adoptKey(candidate?: CryptoKey): Promise<void>;
  flush(): Promise<void>;
  /** Releases both writer locks even when flushing fails. */
  close(): Promise<void>;
}

const JOURNAL = '/.artipod/vault-migration-v1.json';
const DIR = 0o040000;
const REG = 0o100000;
const LINK = 0o120000;
const TYPE = 0o170000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
interface InventoryEntry { path: string; mode: number; size: number; mtimeMs: number; digest?: string }
interface MigrationSource { id: string; target: string; entries: InventoryEntry[] }
interface MigrationJournal { formatVersion: 1; sources: MigrationSource[] }

function validateControl(value: BrowserVaultControl): BrowserVaultControl {
  const fields = ['formatVersion', 'cipher', 'encryptionRequired', 'backend', 'generation', 'phase'];
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !fields.includes(key)) ||
      value.formatVersion !== 1 || value.cipher !== 'aes-256-gcm-chunked' || value.encryptionRequired !== true ||
      !['opfs', 'indexeddb'].includes(value.backend) || !['pending', 'copying', 'cleanup', 'ready'].includes(value.phase) ||
      (value.generation !== null && !/^[a-f0-9]{32}$/.test(value.generation)) ||
      (value.phase !== 'pending' && value.generation === null)) {
    throw new Error('Browser vault bootstrap is corrupt or unsupported; refusing to create another store');
  }
  return value;
}
function opaqueId(): string { return crypto.randomUUID().replace(/-/g, ''); }
function validPath(path: string): void {
  if (!path.startsWith('/') || path.includes('\0') || path.split('/').slice(1).some(p => !p || p === '.' || p === '..')) {
    if (path !== '/') throw new Error('Invalid browser vault migration path');
  }
}
function child(parent: string, name: string): string {
  if (!name || name.includes('/') || name.includes('\0') || name === '.' || name === '..') throw new Error('Invalid legacy entry name');
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}
function destination(target: string, path: string): string { return target === '/' ? path : `${target}${path}`; }
async function contents(filesystem: BrowserVaultSourceFilesystem, path: string): Promise<Uint8Array> {
  const before = await filesystem.stat(path);
  if (!Number.isSafeInteger(before.size) || before.size < 0) throw new Error('Invalid legacy file size');
  const bytes = new Uint8Array(before.size);
  if (bytes.length) await filesystem.read(path, bytes, 0, bytes.length);
  const after = await filesystem.stat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) throw new Error('Legacy file metadata changed during migration');
  return bytes;
}
async function inventory(filesystem: BrowserVaultSourceFilesystem): Promise<InventoryEntry[]> {
  const entries: InventoryEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    const inode = await filesystem.stat(path);
    const type = inode.mode & TYPE;
    if (type !== DIR && type !== REG && type !== LINK) throw new Error('Unsupported legacy filesystem entry');
    entries.push({ path, mode: inode.mode, size: type === DIR ? 0 : inode.size, mtimeMs: type === DIR ? 0 : inode.mtimeMs,
      ...(type === DIR ? {} : { digest: await sha256(await contents(filesystem, path)) }) });
    if (type === DIR) for (const name of (await filesystem.readdir(path)).sort()) await visit(child(path, name));
  };
  for (const name of (await filesystem.readdir('/')).sort()) await visit(child('/', name));
  return entries;
}
async function mkdirp(filesystem: FileSystem, path: string): Promise<void> {
  validPath(path);
  let at = '';
  for (const part of path.split('/').filter(Boolean)) {
    at += `/${part}`;
    if (await filesystem.exists(at)) {
      if (((await filesystem.stat(at)).mode & TYPE) !== DIR) throw new Error('Conflicting legacy migration directories');
    } else await filesystem.mkdir(at, { uid: 0, gid: 0, mode: DIR | 0o755 });
  }
}
async function writeFile(filesystem: FileSystem, path: string, bytes: Uint8Array, mode = REG | 0o600): Promise<void> {
  await mkdirp(filesystem, path.slice(0, path.lastIndexOf('/')) || '/');
  if (!(await filesystem.exists(path))) await filesystem.createFile(path, { uid: 0, gid: 0, mode });
  await filesystem.touch(path, { size: 0 });
  if (bytes.length) await filesystem.write(path, bytes, 0);
  await filesystem.touch(path, { size: bytes.length, mode });
}
async function copySource(source: BrowserVaultLegacySource, filesystem: FileSystem): Promise<MigrationSource> {
  validPath(source.target);
  const entries = await inventory(source.filesystem);
  await mkdirp(filesystem, source.target);
  for (const entry of entries) {
    const path = destination(source.target, entry.path);
    if (await filesystem.exists(path)) {
      const existing = await filesystem.stat(path);
      if ((existing.mode & TYPE) !== (entry.mode & TYPE) ||
          (entry.digest && await sha256(await contents(filesystem, path)) !== entry.digest)) {
        throw new Error('Conflicting legacy sources; original stores were preserved for recovery');
      }
      continue;
    }
    if ((entry.mode & TYPE) === DIR) await filesystem.mkdir(path, { uid: 0, gid: 0, mode: entry.mode });
    else {
      const bytes = await contents(source.filesystem, entry.path);
      if (await sha256(bytes) !== entry.digest) throw new Error('Legacy file contents changed during migration');
      await writeFile(filesystem, path, bytes, entry.mode);
      await filesystem.touch(path, { mtimeMs: entry.mtimeMs });
    }
  }
  const afterInventory = await inventory(source.filesystem);
  if (JSON.stringify(afterInventory) !== JSON.stringify(entries)) throw new Error('Legacy source inventory changed during migration');
  return { id: source.id, target: source.target, entries };
}
async function verifyImported(filesystem: BrowserVaultSourceFilesystem, journal: MigrationJournal): Promise<void> {
  const seen = new Set<string>();
  for (const source of journal.sources) for (const entry of source.entries) {
    const path = destination(source.target, entry.path);
    const inode = await filesystem.stat(path);
    const first = !seen.has(path);
    // Prior backend adoption copied file bytes without preserving modes or
    // timestamps. Identical overlaps retain the current (first) source's
    // metadata, while every original must still agree on type and contents.
    if ((inode.mode & TYPE) !== (entry.mode & TYPE) || (first && inode.mode !== entry.mode) ||
        (entry.digest && ((first && inode.mtimeMs !== entry.mtimeMs) || inode.size !== entry.size || await sha256(await contents(filesystem, path)) !== entry.digest))) {
      throw new Error('Encrypted migration verification failed; legacy storage was preserved');
    }
    seen.add(path);
  }
}
async function journalWrite(filesystem: EncryptedStoreFileSystem, journal: MigrationJournal): Promise<void> {
  await writeFile(filesystem, JOURNAL, encoder.encode(JSON.stringify(journal)));
  await filesystem.flush();
}
async function cleanupLegacy(adapters: BrowserVaultAdapters, filesystem: EncryptedStoreFileSystem): Promise<void> {
  const journal = JSON.parse(decoder.decode(await contents(filesystem, JOURNAL))) as MigrationJournal;
  if (journal.formatVersion !== 1 || !Array.isArray(journal.sources)) throw new Error('Browser vault migration journal is corrupt');
  await verifyImported(filesystem, journal);
  const remaining = new Map((await adapters.legacySources()).map(source => [source.id, source]));
  const expectedIds = new Set(journal.sources.map(source => source.id));
  if ([...remaining.keys()].some(id => !expectedIds.has(id))) {
    throw new Error('New legacy storage appeared after migration; refusing cleanup until it can be recovered');
  }
  for (const expected of journal.sources) {
    const source = remaining.get(expected.id);
    if (source) {
      const known = new Map(expected.entries.map(entry => [entry.path, entry]));
      // Cleanup may have been interrupted midway. Missing old entries are safe;
      // new or changed entries must never be silently discarded.
      for (const actual of await inventory(source.filesystem)) {
        if (JSON.stringify(known.get(actual.path)) !== JSON.stringify(actual)) throw new Error('Legacy storage changed after migration; refusing cleanup');
      }
      await source.cleanup();
    }
    // The verified journal is immutable during cleanup. An interrupted removal
    // is resumed from its surviving source entries, so no journal rewrite can
    // tear after the only plaintext copy has already been removed.
  }
}
async function requireExisting(backing: VaultBacking): Promise<Uint8Array> {
  let root: Uint8Array | undefined;
  if (backing.kind === 'opfs') {
    const file = await (await backing.dir.getFileHandle('0')).getFile();
    root = new Uint8Array(await file.arrayBuffer());
  } else {
    const tx = backing.store.transaction();
    root = await tx.get(0, 0);
    await (tx as { commit?: () => Promise<void> }).commit?.();
  }
  if (!root || !isEncryptedBlob(root)) throw new Error('Browser vault generation is missing or corrupt; refusing to initialize it');
  return root.slice();
}

export async function openBrowserVault(options: {
  getKey: () => CryptoKey;
  backend?: BrowserVaultBackend;
  adapters?: BrowserVaultAdapters;
}): Promise<BrowserVault> {
  const adapters = options.adapters ?? await createBrowserVaultAdapters(options.backend);
  const release = await adapters.acquireWriter();
  let closed = false;
  // The lease service owns the usable key. Remember its validated identity
  // weakly so this filesystem does not keep a key alive after lease expiry.
  let validatedKey: WeakRef<CryptoKey> | null = null;
  let openedFilesystem: EncryptedStoreFileSystem | null = null;
  const backings: VaultBacking[] = [];
  const generation = async (id: string, mode: 'create' | 'open') => {
    const backing = await adapters.generation(id, mode);
    backings.push(backing);
    return backing;
  };
  const closeBackings = () => {
    for (const backing of backings) if (backing.kind === 'store') (backing.store as Store & { close?: () => void }).close?.();
  };
  const accessKey = (): CryptoKey => {
    if (closed) throw new Error('Browser vault is closed');
    const candidate = options.getKey();
    if (candidate !== validatedKey?.deref()) throw new Error('Browser vault key changed; authenticate the renewed key before accessing storage');
    return candidate;
  };
  const assertAccess = () => { accessKey(); };
  try {
    let control = await adapters.readControl();
    if (control) validateControl(control);
    else {
      control = { formatVersion: 1, cipher: 'aes-256-gcm-chunked', encryptionRequired: true,
        backend: adapters.backend, generation: null, phase: 'pending' };
      await adapters.writeControl(control); // Durable policy BEFORE any filesystem initialization.
    }
    if (control.backend !== adapters.backend) throw new Error('Browser vault backend changed; refusing an empty replacement');
    validatedKey = new WeakRef(options.getKey());
    assertAccess();
    let filesystem: EncryptedStoreFileSystem;
    const mountOptions = { getKey: accessKey, strictCiphertext: true, assertAccess };
    if (control.phase === 'pending' || control.phase === 'copying') {
      if (control.generation) await adapters.removeGeneration(control.generation);
      control = { ...control, generation: opaqueId(), phase: 'copying' };
      await adapters.writeControl(control);
      const backing = await generation(control.generation!, 'create');
      filesystem = openedFilesystem = await encryptedStoreMount({ ...mountOptions, backing });
      const journal: MigrationJournal = { formatVersion: 1, sources: [] };
      for (const source of await adapters.legacySources()) journal.sources.push(await copySource(source, filesystem));
      if (await filesystem.exists(JOURNAL)) throw new Error('Reserved browser vault migration file already exists in legacy storage');
      await journalWrite(filesystem, journal);
      // Verify from freshly decrypted PERSISTED blocks, never from the writer's cache.
      await requireExisting(backing);
      filesystem = openedFilesystem = await encryptedStoreMount({ ...mountOptions, backing: await generation(control.generation!, 'open') });
      await verifyImported(filesystem, journal);
      control = { ...control, phase: 'cleanup' };
      await adapters.writeControl(control);
    } else {
      const backing = await generation(control.generation!, 'open');
      await requireExisting(backing);
      filesystem = openedFilesystem = await encryptedStoreMount({ ...mountOptions, backing });
    }
    if (control.phase === 'cleanup') {
      await cleanupLegacy(adapters, filesystem);
      control = { ...control, phase: 'ready' };
      await adapters.writeControl(control);
    }
    // Keep an authenticated ciphertext proof from this generation. Root blocks
    // can subsequently change, but this original proof still binds renewal to
    // the SAME secret without persisting any new plaintext or extracting keys.
    await filesystem.flush();
    const keyProof = await requireExisting(backings[backings.length - 1]);
    const flush = async () => { assertAccess(); await filesystem.flush(); };
    return { filesystem, encrypted: true, backend: control.backend, generation: control.generation!, flush,
      async adoptKey(candidate = options.getKey()) {
        if (closed) throw new Error('Browser vault is closed');
        if (options.getKey() !== candidate) throw new Error('Renewed key is not the current browser session key');
        if (candidate === validatedKey?.deref()) return;
        await decryptBlob(keyProof, candidate);
        if (closed || options.getKey() !== candidate) throw new Error('Browser session changed during key authentication');
        validatedKey = new WeakRef(candidate);
      },
      async close() {
        if (closed) return;
        // Unlike the public fail-fast flush wrapper, this drains in-flight
        // backing I/O even after lease expiry before ownership is released.
        try { await filesystem.flush(); } finally { closed = true; closeBackings(); release(); }
      } };
  } catch (error) {
    // Failed copies also retain ownership until their last queued write has
    // settled. The source remains untouched and a later open can safely retry.
    try { await openedFilesystem?.flush(); } catch { /* preserve the initiating failure */ }
    closed = true; closeBackings(); release(); throw error;
  }
}

// Browser adapters: an atomic IDB bootstrap selects the generation's backing.
// This anchor is independent of OPFS availability and storage preferences.
const CONTROL_DB = 'artipod-vault-control';
const BLOCK_DB_PREFIX = 'artipod-vault-blocks-';
const OPFS_VAULT = 'artipod-vault';
const ROOT_KEEP = new Set(['artipod-fs', 'artipod-models', OPFS_VAULT]);
type TxConstructor = new (store: Store & AsyncMap) => Transaction;

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted')); });
}
async function database(name: string, store: string, create: boolean): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is unavailable; encrypted browser storage cannot open');
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, 1);
    let absent = false;
    opening.onupgradeneeded = () => {
      if (!create) { absent = true; opening.transaction!.abort(); }
      else opening.result.createObjectStore(store);
    };
    opening.onsuccess = () => {
      const db = opening.result;
      if (!db.objectStoreNames.contains(store)) { db.close(); reject(new Error('Unexpected browser storage database schema')); }
      else resolve(db);
    };
    opening.onerror = () => absent ? resolve(null) : reject(opening.error);
    opening.onblocked = () => reject(new Error('Browser storage database is blocked by another tab'));
  });
}
async function readBrowserControl(): Promise<BrowserVaultControl | null> {
  const db = await database(CONTROL_DB, 'control', false);
  if (!db) return null;
  try {
    const tx = db.transaction('control', 'readonly');
    const done = transactionDone(tx);
    const [value] = await Promise.all([request(tx.objectStore('control').get('root')), done]) as [BrowserVaultControl | undefined, void];
    return value === undefined ? null : validateControl(value);
  } finally { db.close(); }
}
async function writeBrowserControl(value: BrowserVaultControl): Promise<void> {
  const db = (await database(CONTROL_DB, 'control', true))!;
  try {
    const tx = db.transaction('control', 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('control').put(validateControl(value), 'root');
    await done;
  } finally { db.close(); }
}
/** Saved legacy data must not disappear behind a fresh memory-only registry. */
export async function browserVaultRequired(): Promise<boolean> {
  if (await readBrowserControl()) return true;
  const root = await browserOpfsRoot();
  if (root) {
    const entries = await directoryEntries(root);
    if (entries.some(([name]) => name === 'artipod-fs' || !ROOT_KEEP.has(name))) return true;
    const generations = await optionalDirectory(root, OPFS_VAULT);
    if (generations && (await directoryEntries(generations)).length) return true;
  }
  if (typeof indexedDB.databases !== 'function') throw new Error('Safe browser storage detection requires IndexedDB database inventory support');
  return (await indexedDB.databases()).some(db => !!db.name && (legacyDatabaseName(db.name) || db.name.startsWith(BLOCK_DB_PREFIX)));
}

async function browserOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  try { return await navigator.storage.getDirectory(); }
  catch (error) { throw new Error('OPFS is present but inaccessible; refusing to bypass legacy or encrypted storage', { cause: error }); }
}
function legacyDatabaseName(name: string): boolean {
  return name === 'artipodfs' || name === 'browser-git-fs' || name.startsWith('artipod-upper::');
}

async function writerLock(name: string): Promise<() => void> {
  if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('Web Locks are required for encrypted browser storage');
  return new Promise((resolve, reject) => {
    let acquired = false;
    void navigator.locks.request(name, { ifAvailable: true, mode: 'exclusive' }, lock => {
      if (!lock) throw new Error('Browser storage already has a writer in another tab');
      acquired = true;
      return new Promise<void>(release => resolve(release));
    }).catch(error => { if (!acquired) reject(error); });
  });
}
async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const deleting = indexedDB.deleteDatabase(name);
    deleting.onsuccess = () => resolve();
    deleting.onerror = () => reject(deleting.error);
    deleting.onblocked = () => reject(new Error('Legacy database cleanup is blocked by another tab'));
  });
}
async function directoryEntries(dir: FileSystemDirectoryHandle): Promise<[string, FileSystemHandle][]> {
  const entries: [string, FileSystemHandle][] = [];
  for await (const entry of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) entries.push(entry);
  return entries;
}
function missing(error: unknown): boolean { return error instanceof DOMException && error.name === 'NotFoundError'; }
async function optionalDirectory(root: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle | null> {
  try { return await root.getDirectoryHandle(name); } catch (error) { if (missing(error)) return null; throw error; }
}
function opfsSource(root: FileSystemDirectoryHandle, keep = new Set<string>()): BrowserVaultSourceFilesystem {
  const handle = async (path: string): Promise<FileSystemHandle> => {
    validPath(path);
    if (path === '/') return root;
    const parts = path.slice(1).split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
    try { return await dir.getDirectoryHandle(parts.at(-1)!); }
    catch (error) { if (!(error instanceof DOMException) || error.name !== 'TypeMismatchError') throw error; }
    return dir.getFileHandle(parts.at(-1)!);
  };
  return {
    async readdir(path) { return (await directoryEntries(await handle(path) as FileSystemDirectoryHandle)).map(([name]) => name).filter(name => path !== '/' || !keep.has(name)); },
    async stat(path) {
      const entry = await handle(path);
      const file = entry.kind === 'file' ? await (entry as FileSystemFileHandle).getFile() : null;
      return { mode: file ? REG | 0o644 : DIR | 0o777, size: file?.size ?? 0, mtimeMs: file?.lastModified ?? 0,
        ctimeMs: 0, birthtimeMs: 0, atimeMs: 0, uid: 0, gid: 0, ino: 0, nlink: 1 } as InodeLike;
    },
    async read(path, bytes, start, end) {
      const file = await (await handle(path) as FileSystemFileHandle).getFile();
      bytes.set(new Uint8Array(await file.slice(start, end).arrayBuffer()));
    },
  };
}
async function rawDatabase(name: string): Promise<Map<number, Uint8Array> | null> {
  const db = await database(name, name, false);
  if (!db) return null;
  try {
    if (db.objectStoreNames.length !== 1) throw new Error('Legacy database has additional stores; refusing destructive cleanup');
    const tx = db.transaction(name, 'readonly');
    const done = transactionDone(tx);
    const store = tx.objectStore(name);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll()), done]);
    const blocks = new Map<number, Uint8Array>();
    keys.forEach((key, i) => {
      if (typeof key !== 'number' || !Number.isSafeInteger(key)) throw new Error('Invalid legacy block identifier');
      const value = values[i] as unknown;
      if (!(value instanceof Uint8Array) && !(value instanceof ArrayBuffer)) throw new Error('Invalid legacy block data');
      blocks.set(key, new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)));
    });
    return blocks;
  } finally { db.close(); }
}
async function legacyDatabaseSource(name: string): Promise<BrowserVaultLegacySource | null> {
  const blocks = await rawDatabase(name);
  if (!blocks) return null;
  const zen = await import('@zenfs/core');
  let filesystem: FileSystem;
  const upper = name.startsWith('artipod-upper::');
  if (!blocks.size || (upper && [...blocks.values()].some(isEncryptedBlob))) {
    // Preserve already encrypted upper blocks verbatim, inside the new vault.
    filesystem = zen.InMemory.create({});
    await filesystem.ready();
    for (const [id, bytes] of blocks) {
      await writeFile(filesystem, `/${id}`, bytes);
      // Raw IDB blocks have no per-file timestamp. Use a stable synthetic one
      // so re-inventorying during cleanup does not invent source changes.
      await filesystem.touch(`/${id}`, { mtimeMs: 1 });
    }
  } else {
    const store = new zen.InMemoryStore();
    for (const [id, bytes] of blocks) store.set(id, bytes);
    if (!store.has(0)) throw new Error('Legacy filesystem root is missing; refusing migration');
    filesystem = new zen.StoreFS(store);
    await filesystem.ready();
  }
  return { id: `idb:${name}`, filesystem, target: upper ? `/.artipod/uppers/${name.slice('artipod-upper::'.length)}` : '/', cleanup: () => deleteDatabase(name) };
}

class IdbVaultStore implements Store, AsyncMap {
  readonly flags = [] as const;
  readonly name = 'vault-indexeddb-blocks';
  constructor(private readonly db: IDBDatabase, private readonly ids: Set<number>, private readonly Tx: TxConstructor) {}
  keys(): Iterable<number> { return this.ids; }
  cached(): undefined { return undefined; }
  async get(id: number): Promise<Uint8Array | undefined> {
    const tx = this.db.transaction('blocks', 'readonly');
    const done = transactionDone(tx);
    const [value] = await Promise.all([request(tx.objectStore('blocks').get(id)), done]) as [Uint8Array | undefined, void];
    return value && new Uint8Array(value);
  }
  async set(id: number, bytes: Uint8Array, offset = 0): Promise<void> {
    if (offset) throw new Error('Encrypted vault block writes must replace a whole block');
    const tx = this.db.transaction('blocks', 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('blocks').put(bytes, id);
    await done;
    this.ids.add(id);
  }
  async delete(id: number): Promise<void> {
    const tx = this.db.transaction('blocks', 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('blocks').delete(id);
    await done;
    this.ids.delete(id);
  }
  transaction(): Transaction { return new this.Tx(this); }
  async sync(): Promise<void> { /* Every mutation awaits its IDB transaction. */ }
  close(): void { this.db.close(); }
  usage(): UsageInfo { return { totalSpace: 0, freeSpace: 0 }; }
}

export async function createBrowserVaultAdapters(preferred?: BrowserVaultBackend): Promise<BrowserVaultAdapters> {
  const control = await readBrowserControl();
  const opfs = await browserOpfsRoot();
  const backend = control?.backend ?? preferred ?? (opfs ? 'opfs' : 'indexeddb');
  if (backend === 'opfs' && !opfs) throw new Error('Existing or requested OPFS vault is unavailable; refusing another backing');
  if (!control) {
    const directory = opfs && await optionalDirectory(opfs, OPFS_VAULT);
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    if ((directory && (await directoryEntries(directory)).length) || databases.some(db => db.name?.startsWith(BLOCK_DB_PREFIX))) {
      throw new Error('Encrypted browser generations exist without their bootstrap; refusing an empty replacement');
    }
  }
  return {
    backend, readControl: readBrowserControl, writeControl: writeBrowserControl,
    async acquireWriter() {
      const releaseVault = await writerLock('artipod-vault');
      try {
        const releaseLegacy = await writerLock('artipod-sync-fs');
        return () => { releaseLegacy(); releaseVault(); };
      } catch (error) { releaseVault(); throw error; }
    },
    async generation(id, mode) {
      if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid vault generation');
      if (backend === 'opfs') {
        const root = await opfs!.getDirectoryHandle(OPFS_VAULT, { create: mode === 'create' });
        return { kind: 'opfs', dir: await root.getDirectoryHandle(id, { create: mode === 'create' }) };
      }
      const db = await database(`${BLOCK_DB_PREFIX}${id}`, 'blocks', mode === 'create');
      if (!db) throw new Error('Browser vault generation is missing');
      const tx = db.transaction('blocks', 'readonly');
      const done = transactionDone(tx);
      const [keys] = await Promise.all([request(tx.objectStore('blocks').getAllKeys()), done]);
      const zen = await import('@zenfs/core');
      return { kind: 'store', store: new IdbVaultStore(db, new Set(keys.map(Number)), zen.AsyncMapTransaction as unknown as TxConstructor) };
    },
    async removeGeneration(id) {
      if (backend === 'indexeddb') return deleteDatabase(`${BLOCK_DB_PREFIX}${id}`);
      const root = await optionalDirectory(opfs!, OPFS_VAULT);
      try { await root?.removeEntry(id, { recursive: true }); } catch (error) { if (!missing(error)) throw error; }
    },
    async legacySources() {
      const sources: BrowserVaultLegacySource[] = [];
      if (opfs) {
        const legacy = await optionalDirectory(opfs, 'artipod-fs');
        if (legacy) sources.push({ id: 'opfs:artipod-fs', filesystem: opfsSource(legacy), target: '/',
          cleanup: () => opfs!.removeEntry('artipod-fs', { recursive: true }) });
        if ((await directoryEntries(opfs)).some(([name]) => !ROOT_KEEP.has(name))) sources.push({
          id: 'opfs:legacy-root', filesystem: opfsSource(opfs, ROOT_KEEP), target: '/',
          async cleanup() { for (const [name] of await directoryEntries(opfs!)) if (!ROOT_KEEP.has(name)) await opfs!.removeEntry(name, { recursive: true }); },
        });
      }
      if (!indexedDB.databases) throw new Error('Safe legacy migration requires IndexedDB database inventory support');
      const names = (await indexedDB.databases()).map(db => db.name).filter((name): name is string => !!name && legacyDatabaseName(name));
      // Current root first; identical overlaps are harmless, conflicting data stops migration.
      names.sort((a, b) => (a === 'artipodfs' ? -1 : b === 'artipodfs' ? 1 : a.localeCompare(b)));
      for (const name of names) { const source = await legacyDatabaseSource(name); if (source) sources.push(source); }
      return sources;
    },
  };
}
