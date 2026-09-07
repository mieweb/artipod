/**
 * Inventory providers for the shells: the SAME derivations Catalog.tsx
 * renders, so `images` / `lsblk` / /proc line up with the page.
 */
import type { ImageDetail, ImageRow, InventoryProviders, VolumeRow } from '@artipod/core/proc';
import { mountSlug } from '@artipod/core/proc';
import { catalogStore, refreshServer, E2E_MEDIA_TYPE } from '../stores/catalog';
import { keys, uiState } from '../boot';

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
    async imageDetail(ref): Promise<ImageDetail | null> {
      const { serverRefs } = await serverState();
      const row = serverRefs?.find((r) => r.ref === ref);
      if (!row?.manifestDigest) return null;
      const { OciStore, OCI_ROOT, digestHex } = await import('@artipod/core/oci');
      const { fs } = await import('../filesystem');
      const hex = digestHex(row.manifestDigest as never);
      const localPath = `${OCI_ROOT}/blobs/sha256/${hex}`;
      const aliasPath = `${localPath}.alias`;
      const stat = async (p: string) => fs.promises.stat(p).then(() => true, () => false);
      const [blobPresent, aliasPresent] = await Promise.all([stat(localPath), stat(aliasPath)]);
      const detail: ImageDetail = {
        manifestDigest: row.manifestDigest, localPath, localPresent: blobPresent || aliasPresent,
        aliasPath: aliasPresent ? aliasPath : undefined, remoteUrl: `${location.origin}/api/pods/blobs/${row.manifestDigest}`,
        layers: [], parents: [],
      };
      // Read locally (decrypting with the leased key) and fall back to the server.
      type Manifest = { layers: { digest: string; size: number; annotations?: Record<string, string> }[]; annotations?: Record<string, string> };
      const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Manifest;
      let manifest: Manifest | undefined;
      try {
        const store = new OciStore(fs as ConstructorParameters<typeof OciStore>[0]);
        await store.init();
        const key = keys().getKey();
        if (key) await store.enableEncryption(() => key);
        if (detail.localPresent) manifest = decode(await store.getBlob(row.manifestDigest as never));
      } catch { /* locked or missing: try the server */ }
      if (!manifest) {
        try {
          const { HttpPodStore } = await import('@artipod/core/manager');
          manifest = decode(await new HttpPodStore('/api/pods').getBlob(row.manifestDigest as never));
        } catch (e) {
          detail.unavailable = row.encrypted && !keys().getKey()
            ? 'locked — this tab holds no key lease; log in to read the manifest'
            : `unavailable (${(e as Error).message})`;
          return detail;
        }
      }
      const found: Manifest = manifest;
      detail.layers = found.layers.map((l) => ({
        digest: l.digest, size: l.size, path: l.annotations?.['org.artipod.path'],
        mtimeMs: l.annotations?.['org.artipod.mtime'] ? Number(l.annotations['org.artipod.mtime']) : undefined,
        actor: l.annotations?.['org.artipod.actor'], overlay: !!l.annotations?.['org.artipod.overlay'],
      }));
      const rawParents = found.annotations?.['org.artipod.parents'] ?? '';
      detail.parents = rawParents.trim().startsWith('[')
        ? (JSON.parse(rawParents) as string[])
        : rawParents.split(',').map((s) => s.trim()).filter(Boolean);
      detail.actor = found.annotations?.['org.artipod.actor'];
      return detail;
    },
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
