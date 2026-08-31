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
} from './registry.js';
export type { ProcModule, ProcProvider, ProcTree } from './registry.js';
export {
  hashContent,
  mkdirp,
  PROC_MOUNT,
  procEntries,
  procPathOf,
  refreshProc,
  unmountProc,
  writeTree,
} from './snapshot.js';
export type { ProcEntry } from './snapshot.js';
export { reconcileProc } from './reconcile.js';
export { registerBuiltinProviders, storageProvider } from './storage-provider.js';
export { makePodManifestProvider, registerPodManifestProvider } from './pod-provider.js';
