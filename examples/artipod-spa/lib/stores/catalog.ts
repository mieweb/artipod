/**
 * Catalog store — the U0 pattern-setter for every store in this app
 * (spa-ui-plan P4): a VANILLA zustand store (no React import) holding only
 * serializable snapshots; async work lives in actions; effects/services call
 * `catalogStore.getState().…`, components bind with `useStore(catalogStore)`.
 */
import { createStore } from 'zustand/vanilla';

/** Wire shape of GET /api/pods/refs (core StoredRef + serve's decoration). */
export interface ServerRef {
  ref: string;
  manifestDigest: string;
  mediaType: string;
  pulledAt: string;
  encrypted?: boolean;
}

export interface CatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  refs: ServerRef[];
  error?: string;
  refreshServer(fetchImpl?: typeof fetch): Promise<void>;
}

export const catalogStore = createStore<CatalogState>()((set) => ({
  status: 'idle',
  refs: [],
  error: undefined,
  async refreshServer(fetchImpl) {
    // Deref the global at call time: the key broker patches fetch (U1).
    const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    set({ status: 'loading', error: undefined });
    try {
      const res = await doFetch('/api/pods/refs');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const refs = (await res.json()) as ServerRef[];
      set({ refs, status: 'ready' });
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },
}));
