/**
 * Catalog store (spa-ui-plan U2): everything the catalog renders, as
 * serializable snapshots — server refs (with serve's encryption/lock decor),
 * this machine's heads, ancestry verdicts, and which refs have real local
 * changes. Actions live in services/catalog-refresh.
 */
import { createStore } from 'zustand/vanilla';

export const E2E_MEDIA_TYPE = 'application/vnd.artipod.encrypted-ref.v1+json';

/** Wire shape of GET /api/pods/refs (core StoredRef + serve's decoration). */
export interface ServerRef {
  ref: string;
  manifestDigest: string;
  mediaType?: string;
  pulledAt?: string;
  encrypted?: boolean;
  locked?: boolean;
}

export type SyncVerdict = 'synced' | 'ahead' | 'behind';

export interface CatalogSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** null = not fetched yet (renders "loading…"). */
  serverRefs: ServerRef[] | null;
  error?: string;
  /** ref → manifest digest in THIS machine's store — 'synced' is a verified claim. */
  localHeads: Record<string, string>;
  /** ancestry verdict per server ref. */
  verdicts: Record<string, SyncVerdict>;
  /** refs with a non-empty overlay upper (actual local changes). */
  changedRefs: string[];
}

export const catalogStore = createStore<CatalogSnapshot>()(() => ({
  status: 'idle',
  serverRefs: null,
  localHeads: {},
  verdicts: {},
  changedRefs: [],
}));

/** Server list refresh (the UI artifact is infrastructure — filtered out). */
export async function refreshServer(fetchImpl?: typeof fetch): Promise<void> {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  catalogStore.setState({ status: 'loading', error: undefined });
  try {
    const res = await doFetch('/api/pods/refs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const refs = (await res.json()) as ServerRef[];
    catalogStore.setState({ serverRefs: refs.filter((r) => !r.ref.startsWith('artipod-ui:')), status: 'ready' });
  } catch (err) {
    catalogStore.setState({
      serverRefs: catalogStore.getState().serverRefs ?? [],
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
