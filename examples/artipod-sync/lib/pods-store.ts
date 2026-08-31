/**
 * The deployment's pod store singleton (OCI image-layout directory at
 * ARTIPOD_STORE_DIR) — shared by /api/pods/[...path] (sync surface) and
 * /api/pods/publish (folder publisher).
 */
import { nodePodFs } from '@artipod/core';
import { OciLayoutPodStore } from '@artipod/core/manager';

let storePromise: Promise<OciLayoutPodStore> | null = null;

export function getPodStore(): Promise<OciLayoutPodStore> {
  if (!storePromise) {
    storePromise = (async () => {
      const store = new OciLayoutPodStore(nodePodFs(), process.env.ARTIPOD_STORE_DIR ?? '.artipod-store');
      await store.init();
      return store;
    })();
  }
  return storePromise;
}
