/**
 * The proc framework: host state projected into `/proc` as files.
 *
 * Apps register providers; the sandbox refreshes the snapshot before every
 * command and reconciles writes back afterwards. See ./README.md.
 */
export {
  clearProcProviders,
  enabledProviders,
  getProvider,
  listProviders,
  providerRoot,
  registerProcProvider,
  setProviderEnabled,
} from './registry';
export type { ProcModule, ProcProvider, ProcTree } from './registry';
export {
  hashContent,
  mkdirp,
  PROC_MOUNT,
  procEntries,
  procPathOf,
  refreshProc,
  unmountProc,
  writeTree,
} from './snapshot';
export type { ProcEntry } from './snapshot';
export { reconcileProc } from './reconcile';
export { registerBuiltinProviders, storageProvider } from './storage-provider';
