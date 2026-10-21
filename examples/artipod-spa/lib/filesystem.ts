/** App bindings only. Core owns storage policy, custody, migration and lifecycle. */
import { createStorageSession, StorageClosePersistenceError, type StorageSession, type StorageSessionInfo } from '@artipod/core/storage';
import type { StorageBackend, ZenFsLike } from '@artipod/core/sandbox';
import { loadBackendPref } from '@artipod/core/sandbox';
import { keys } from './boot';

export type ZenFs = ZenFsLike;
export let fs: ZenFs;
export let fsInfo: StorageSessionInfo | null = null;
let session: StorageSession | undefined;

function storage(pref?: StorageBackend): StorageSession {
  const backend = pref ?? loadBackendPref();
  return session ??= createStorageSession({ policy: 'broker', keys: keys(), backend: backend === 'opfs' || backend === 'indexeddb' ? backend : undefined });
}

export { StorageClosePersistenceError as FileSystemClosePersistenceError };
export function registerFileSystemTeardown(close: () => Promise<void>, source?: string): () => Promise<void> { return storage().registerTeardown(close, source); }
export function fileSystemNeedsRecovery(): boolean { return session?.needsRecovery() ?? false; }
export async function initFileSystem(pref?: StorageBackend): Promise<StorageSessionInfo | null> {
  if (typeof window === 'undefined') return null;
  const info = await storage(pref).open();
  fs = info.zfs; fsInfo = info;
  return info;
}
export async function recoverFileSystem(pref?: StorageBackend): Promise<{ info: StorageSessionInfo; warning: string }> {
  const result = await storage(pref).recover();
  fs = result.info.zfs; fsInfo = result.info;
  return result;
}
export async function flushFileSystem(): Promise<void> { await session?.flush(); }
export async function resetFileSystem() {
  try { return await storage().reset(); }
  finally { fsInfo = null; }
}
export async function closeFileSystem(): Promise<void> {
  try { await session?.close(); }
  finally { fsInfo = null; }
}
export async function openFileSystemWorkspaceUpper(ref: string) { return storage().openWorkspaceUpper(ref); }
