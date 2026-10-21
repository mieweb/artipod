/** Protected local storage. Persistent sessions encrypt before the first backing write. */
export { createStorageSession, StorageSession, StorageClosePersistenceError } from './session.js';
export type { StorageSessionOptions, StorageSessionInfo, StorageSessionSnapshot } from './session.js';
export type { StorageContext, StoragePolicy, StorageProtection, StorageAccessOptions } from './context.js';
export * from './keys.js';
export * from './adapters.js';
export * from './task-scheduler.js';
export * from './browser-vault.js';
export * from './encrypted-store.js';
export * from './directory-store.js';
export { workspaceUpperPaths, upperDirName, openWorkspaceUpper } from './workspace.js';
export { readStorageTextFile, writeStorageTextFile } from './text-file.js';
export type { StorageTextFileOptions } from './text-file.js';
