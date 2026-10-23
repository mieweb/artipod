/** App bindings only. Core owns storage policy, custody, migration and lifecycle. */
import { createStorageSession, StorageClosePersistenceError, type StorageSession, type StorageSessionInfo, type StorageSessionSnapshot } from '@artipod/core/storage';
import type { StorageBackend, ZenFsLike } from '@artipod/core/sandbox';
import { loadBackendPref } from '@artipod/core/sandbox';
import { acknowledgeUiStateRecovery, flushUiState, keys } from './boot';
import { hostSave } from './services/host-save';

export type ZenFs = ZenFsLike;
export let fs: ZenFs;
export let fsInfo: StorageSessionInfo | null = null;
let session: StorageSession | undefined;
const closedSnapshot: StorageSessionSnapshot = Object.freeze({ status: 'closed', needsRecovery: false });
const listeners = new Set<() => void>();
let unsubscribeSession: (() => void) | undefined;

function observeSession(): void {
  if (session && listeners.size && !unsubscribeSession) unsubscribeSession = session.subscribe(() => {
    for (const listener of listeners) listener();
  });
}

function storage(pref?: StorageBackend): StorageSession {
  const backend = pref ?? loadBackendPref();
  if (!session) {
    session = createStorageSession({ policy: 'broker', keys: keys(), backend: backend === 'opfs' || backend === 'indexeddb' ? backend : undefined });
    observeSession();
  }
  return session;
}

export { StorageClosePersistenceError as FileSystemClosePersistenceError };
/** Observe core lifecycle without creating storage before its caller chooses a backend. */
export function subscribeFileSystem(listener: () => void): () => void {
  listeners.add(listener);
  observeSession();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { unsubscribeSession?.(); unsubscribeSession = undefined; }
  };
}
export function getFileSystemSnapshot(): StorageSessionSnapshot { return session?.getSnapshot() ?? closedSnapshot; }
export function getServerFileSystemSnapshot(): StorageSessionSnapshot { return closedSnapshot; }
export function registerFileSystemTeardown(close: () => Promise<void>, source?: string): () => Promise<void> { return storage().registerTeardown(close, source); }
export function fileSystemNeedsRecovery(): boolean { return session?.needsRecovery() ?? false; }
export async function initFileSystem(pref?: StorageBackend): Promise<StorageSessionInfo | null> {
  if (typeof window === 'undefined') return null;
  (window as unknown as { __artipodSave: () => Promise<void> }).__artipodSave = saveFileSystem;
  const info = await storage(pref).open();
  fs = info.zfs; fsInfo = info;
  return info;
}
export async function recoverFileSystem(pref?: StorageBackend): Promise<{ info: StorageSessionInfo; warning: string }> {
  const result = await storage(pref).recover();
  fs = result.info.zfs; fsInfo = result.info;
  await acknowledgeUiStateRecovery();
  return result;
}
export async function flushFileSystem(): Promise<void> { await session?.flush(); }
/** Await queued host/service work and durability before intentionally reloading. */
export async function saveFileSystem(): Promise<void> {
  await hostSave.save(async () => {
    await keys().flush();
    await flushUiState();
    await session?.flush();
  });
}
export async function resetFileSystem() {
  try { return await storage().reset(); }
  finally { fsInfo = null; }
}
export async function closeFileSystem(): Promise<void> {
  try { await session?.close(); }
  finally { fsInfo = null; }
}
export async function openFileSystemWorkspaceUpper(ref: string) { return storage().openWorkspaceUpper(ref); }
