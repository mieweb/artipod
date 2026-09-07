/**
 * Inventory providers for the shells: the SAME derivations Catalog.tsx
 * renders, so `images` / `lsblk` / /proc line up with the page.
 */
import type { ImageRow, InventoryProviders, VolumeRow } from '@artipod/core/proc';
import { mountSlug } from '@artipod/core/proc';
import { catalogStore, refreshServer, E2E_MEDIA_TYPE } from '../stores/catalog';
import { uiState } from '../boot';

/** Ids whose workspace tab is alive — each holds a Web Lock for its lifetime. */
export async function liveWorkspaceIds(): Promise<Set<string>> {
  try {
    const { held } = await navigator.locks.query();
    return new Set((held ?? []).map((l) => l.name ?? '').filter((n) => n.startsWith('artipod-ws-')).map((n) => n.slice('artipod-ws-'.length)));
  } catch {
    return new Set();
  }
}

const encryptionOf = (encrypted?: boolean, mediaType?: string): ImageRow['encryption'] =>
  mediaType === E2E_MEDIA_TYPE ? 'e2e' : encrypted ? 'encrypted' : 'plaintext';

// A workspace tab never renders the catalog, so the server list may be cold.
// The registry file is the cross-tab truth: read it, don't poke the page's store.
async function serverState() {
  if (catalogStore.getState().serverRefs === null) await refreshServer().catch(() => {});
  return catalogStore.getState();
}
async function localEntries() {
  const { io } = await uiState();
  return (await io.read()).workspaces;
}

export function catalogInventory(): InventoryProviders {
  return {
    async images(): Promise<ImageRow[]> {
      const { serverRefs, verdicts, changedRefs } = await serverState();
      const local = await localEntries();
      const changed = new Set(changedRefs);
      return (serverRefs ?? []).map(({ ref, manifestDigest, encrypted, locked, mediaType }) => {
        const opened = local.find((e) => e.id === ref);
        const forked = opened?.kind === 'pod' && opened.mode === 'cow' && changed.has(ref);
        const verdict = verdicts[ref];
        const status = forked ? 'forked'
          : verdict === 'ahead' || (verdict === undefined && opened?.unsynced) ? 'out of sync'
          : changed.has(ref) ? 'local changes'
          : verdict === 'behind' ? 'update available'
          : verdict === 'synced' ? 'synced' : undefined;
        return { ref, digest: manifestDigest, encryption: encryptionOf(encrypted, mediaType), locked, status };
      });
    },
    async volumes(): Promise<VolumeRow[]> {
      const { serverRefs, changedRefs } = await serverState();
      const local = await localEntries();
      const changed = new Set(changedRefs);
      const live = await liveWorkspaceIds();
      return local.map((e) => {
        const fork = e.kind === 'pod' && e.mode === 'cow';
        const onServer = serverRefs?.some((r) => r.ref === e.id) ?? false;
        const state = e.kind === 'blank' ? (e.hasChanges ? 'has files' : 'empty')
          : fork ? (changed.has(e.id) ? 'unpublished' : 'clean fork')
          : e.unsynced ? 'unsynced' : onServer ? 'synced' : 'local';
        return {
          name: e.id,
          type: e.kind === 'blank' ? 'blank' : fork ? 'fork' : 'ref',
          mode: e.mode ?? 'rw',
          encryption: e.encrypted ? 'encrypted' : 'plaintext',
          state,
          mountpoint: live.has(e.id) ? (e.kind === 'blank' ? `/work/${e.id}` : `/open/${mountSlug(e.id)}`) : undefined,
        };
      });
    },
  };
}
