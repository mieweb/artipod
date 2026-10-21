/** Internal capability registry. Public metadata never establishes storage trust. */
import type { FileSystem } from '@zenfs/core';
import type { ZenFsLike } from '../sandbox/types.js';

export type StoragePolicy = 'protected' | 'memory' | 'plaintext';
export type StorageProtection = 'encrypted' | 'volatile' | 'plaintext';

export interface StorageContext {
  readonly zfs: ZenFsLike;
  readonly protection: StorageProtection;
  readonly backend: string;
  readonly generation?: string;
  flush(): Promise<void>;
  assertAccess(): void;
}

export interface StorageAccessOptions {
  storage?: StorageContext;
  storagePolicy?: StoragePolicy;
}

interface ContextRecord {
  readonly zfs: ZenFsLike;
  readonly protection: StorageProtection;
  readonly assertActive: () => void;
  readonly assertAccess: () => void;
  readonly wrapFilesystem?: (source: ZenFsLike, release?: () => void) => ZenFsLike;
}
interface RootRecord {
  readonly protection: StorageProtection;
  readonly isOwned: () => boolean;
  readonly assertAccess: () => void;
}

const contexts = new WeakMap<object, ContextRecord>();
const invalidated = new WeakSet<object>();
const filesystems = new WeakMap<object, StorageContext>();
const roots = new WeakMap<object, RootRecord>();
const projections = new WeakMap<object, StorageContext>();
let configuredRoot: object | undefined;
let rootConfiguration: object | undefined;
let rawOperation: object | undefined;
let rootGeneration = 0;
const rawSingletons = new WeakSet<object>();

export function registerStorageContext(context: StorageContext, options: { assertActive: () => void; wrapFilesystem?: (source: ZenFsLike, release?: () => void) => ZenFsLike }): void {
  if (contexts.has(context)) throw new Error('Storage context is already registered');
  const record = { zfs: context.zfs, protection: context.protection, assertActive: options.assertActive, assertAccess: context.assertAccess.bind(context), wrapFilesystem: options.wrapFilesystem };
  contexts.set(context, Object.freeze(record));
  filesystems.set(record.zfs, context);
}

export function invalidateStorageContext(context: StorageContext): void {
  if (contexts.has(context)) invalidated.add(context);
}

export function resolveStorageContext(context: StorageContext, expectedFs?: ZenFsLike, requestedPolicy?: StoragePolicy): StorageContext {
  const record = context && typeof context === 'object' ? contexts.get(context) : undefined;
  if (!record || invalidated.has(context)) throw new Error('A live core storage context is required');
  if (expectedFs && record.zfs !== expectedFs) throw new Error('Storage context does not own the adopted filesystem');
  if (context.zfs !== record.zfs || context.protection !== record.protection) throw new Error('Storage context metadata changed');
  record.assertActive();
  record.assertAccess();
  if (requestedPolicy === 'protected' && record.protection === 'plaintext') throw new Error('Protected storage requires an encrypted or volatile core storage context');
  if (requestedPolicy === 'memory' && record.protection !== 'volatile') throw new Error('Memory storage requires a volatile core storage context');
  if (requestedPolicy === 'plaintext' && record.protection !== 'plaintext') throw new Error('A protected storage context cannot be downgraded to plaintext');
  return context;
}

/** Resolve explicit policy or infer the owned context of a core filesystem. */
export function resolveStorageAccess(zfs: ZenFsLike, options: StorageAccessOptions = {}): StorageContext | undefined {
  const context = options.storage ?? filesystems.get(zfs);
  if (context) return resolveStorageContext(context, zfs, options.storagePolicy);
  if (options.storagePolicy === 'protected' || options.storagePolicy === 'memory') throw new Error('A live core storage context is required for the requested storage policy');
  return undefined;
}

/** Internal child views retain their owner's operation gates and descriptor custody. */
export function guardStorageFileSystem(context: StorageContext, source: ZenFsLike, release?: () => void): ZenFsLike {
  resolveStorageContext(context);
  const wrap = contexts.get(context)!.wrapFilesystem;
  if (!wrap) throw new Error('The storage context cannot create guarded filesystem views');
  return wrap(source, release);
}

export function registerStorageRoot(root: FileSystem, record: RootRecord): void {
  if (roots.get(root)?.isOwned()) throw new Error('Storage root is already registered and owned');
  roots.set(root, Object.freeze({ ...record }));
}

export function assertStorageRootConfiguration(root: FileSystem, protectedPersistence = false, storagePolicy?: StoragePolicy): void {
  const current = configuredRoot && roots.get(configuredRoot);
  if (current?.isOwned() && configuredRoot !== root) throw new Error('The core storage session owns the root; close it before replacing storage');
  const record = roots.get(root);
  if (protectedPersistence && (!record || record.protection === 'plaintext')) throw new Error('Protected persistence requires a core-owned encrypted or volatile root');
  if (record) {
    if (!record.isOwned()) throw new Error('The core storage root is no longer owned');
    record.assertAccess();
    if (storagePolicy === 'protected' && record.protection === 'plaintext') throw new Error('Protected storage requires an encrypted or volatile core storage root');
    if (storagePolicy === 'memory' && record.protection !== 'volatile') throw new Error('Memory storage requires a volatile core storage root');
    if (storagePolicy === 'plaintext' && record.protection !== 'plaintext') throw new Error('A protected storage root cannot be downgraded to plaintext');
    return;
  }
  if (storagePolicy === 'protected' || storagePolicy === 'memory') throw new Error('The requested storage policy requires a core-owned root');
  if (root.name !== 'tmpfs' && storagePolicy !== 'plaintext') throw new Error('Raw persistent storage requires an explicit storagePolicy: plaintext choice');
}

export function activateStorageRoot(root: FileSystem, singleton?: ZenFsLike): void {
  if (configuredRoot !== root) rootGeneration++;
  configuredRoot = root;
  rootConfiguration = undefined;
  if (singleton) rawSingletons.add(singleton);
}

/** Reserve singleton ownership before configure's dynamic import or backend awaits. */
export function reserveStorageRoot(root: FileSystem, protectedPersistence = false, storagePolicy?: StoragePolicy): () => void {
  if (rawOperation) throw new Error('A raw storage operation is in progress; retry after it has finished');
  if (rootConfiguration) throw new Error('Another storage operation owns the root configuration');
  assertStorageRootConfiguration(root, protectedPersistence, storagePolicy);
  const previous = configuredRoot;
  const reservation = {};
  rootConfiguration = reservation;
  configuredRoot = root;
  // Reserving also retires raw views before configure can switch global mounts.
  if (previous !== root) rootGeneration++;
  return () => {
    if (rootConfiguration !== reservation) return;
    rootConfiguration = undefined;
    if (configuredRoot === root) configuredRoot = previous;
  };
}

export function assertRawStorageOperation(operation: string): void {
  if (rootConfiguration) throw new Error(`${operation}: another storage operation owns the root configuration`);
  const record = configuredRoot && roots.get(configuredRoot);
  if (record?.isOwned() && record.protection !== 'plaintext') throw new Error(`${operation}: the core storage session owns the protected root; raw storage cannot replace or expose it`);
}

/** Hold the singleton exclusion through backend awaits, mutation, and cleanup. */
export function beginRawStorageOperation(operation: string, options: { allowProtectedRoot?: boolean } = {}): () => void {
  if (rawOperation) throw new Error(`${operation}: another raw storage operation is in progress`);
  if (rootConfiguration) throw new Error(`${operation}: another storage operation owns the root configuration`);
  if (!options.allowProtectedRoot) assertRawStorageOperation(operation);
  const reservation = {};
  rawOperation = reservation;
  return () => { if (rawOperation === reservation) rawOperation = undefined; };
}

/** Legacy singleton consumers must not follow a later core-owned root. */
export function captureRawStorageAccess(zfs: ZenFsLike): () => void {
  const generation = rootGeneration;
  return () => {
    // A caller can retain the singleton before the first core configure.
    // Recognize it when that configure registers it, without affecting
    // independently supplied filesystem implementations.
    if (!rawSingletons.has(zfs)) return;
    if (generation !== rootGeneration) throw new Error('The raw storage filesystem no longer owns the configured root');
    assertRawStorageOperation('Raw filesystem access');
  };
}

export function registerStorageProjection(root: FileSystem, context: StorageContext): void {
  resolveStorageContext(context);
  projections.set(root, context);
}

export function assertStorageProjection(root: unknown, context: StorageContext): void {
  resolveStorageContext(context);
  if (!root || typeof root !== 'object' || projections.get(root) !== context) throw new Error('Protected overlay uppers must be created by the owning core storage session');
}
