/**
 * /proc/pod — projects the pod's manifest into the shell and the model's
 * view (plan Phase 3 / Decision #3: prompts and tools must echo the ACTUAL
 * mount table; models cannot rely on a memorized layout).
 */

import { registerProcProvider, type ProcProvider, type ProcTree } from './registry.js';
import { serializeManifest, type PodManifest } from '../manifest.js';

let unregisterCurrent: (() => void) | null = null;

export function makePodManifestProvider(manifest: PodManifest): ProcProvider {
  return {
    name: 'pod',
    description: 'Pod manifest (declarative mount table)',
    mode: 'ro',
    async read(): Promise<ProcTree> {
      return { 'manifest.json': serializeManifest(manifest) };
    },
  };
}

/**
 * Register (or replace) the pod provider — one pod per proc registry, so a
 * re-realized pod simply supersedes the previous projection.
 */
export function registerPodManifestProvider(manifest: PodManifest): () => void {
  unregisterCurrent?.();
  const unregister = registerProcProvider(makePodManifestProvider(manifest));
  unregisterCurrent = () => {
    unregister();
    unregisterCurrent = null;
  };
  return unregisterCurrent;
}
