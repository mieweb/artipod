/**
 * Inventory providers for the shells: the SAME derivations Catalog.tsx
 * renders, so `images` / `volumes` / /proc line up with the page.
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
      type Layer = { digest: string; size: number; annotations?: Record<string, string> };
      type Manifest = { layers: Layer[]; annotations?: Record<string, string> };
      const store = new OciStore(fs as ConstructorParameters<typeof OciStore>[0]);
      await store.init();
      const key = keys().getKey();
      if (key) await store.enableEncryption(() => key);
      // A manifest by digest: local store first (decrypting with the leased key), then the server.
      const readManifest = async (digest: string): Promise<{ text: string; manifest: Manifest } | undefined> => {
        let bytes: Uint8Array | undefined;
        try { if (await store.hasBlob(digest as never)) bytes = await store.getBlob(digest as never); } catch { /* locked or missing */ }
        if (!bytes) {
          try {
            const { HttpPodStore } = await import('@artipod/core/manager');
            bytes = await new HttpPodStore('/api/pods').getBlob(digest as never);
          } catch { return undefined; }
        }
        const text = new TextDecoder().decode(bytes);
        return { text, manifest: JSON.parse(text) as Manifest };
      };
      const head = await readManifest(row.manifestDigest);
      if (!head) {
        detail.unavailable = row.encrypted && !key
          ? 'locked — this tab holds no key lease; log in to read the manifest'
          : 'unavailable — neither the local store nor the server returned the manifest';
        return detail;
      }
      const toRow = async (l: Layer) => ({
        digest: l.digest, size: l.size, path: l.annotations?.['org.artipod.path'],
        mtimeMs: l.annotations?.['org.artipod.mtime'] ? Number(l.annotations['org.artipod.mtime']) : undefined,
        actor: l.annotations?.['org.artipod.actor'], overlay: !!l.annotations?.['org.artipod.overlay'],
        local: await store.hasBlob(l.digest as never).catch(() => false),
      });
      detail.manifest = head.text;
      detail.layers = await Promise.all(head.manifest.layers.map(toRow));
      const rawParents = head.manifest.annotations?.['org.artipod.parents'] ?? '';
      detail.parents = rawParents.trim().startsWith('[')
        ? (JSON.parse(rawParents) as string[])
        : rawParents.split(',').map((s) => s.trim()).filter(Boolean);
      detail.actor = head.manifest.annotations?.['org.artipod.actor'];
      // What this head changed: layers not carried by the first parent (per-file layers make this exact).
      if (detail.parents[0]) {
        const parent = await readManifest(detail.parents[0]);
        if (parent) {
          const inherited = new Set(parent.manifest.layers.map((l) => l.digest));
          detail.changed = detail.layers.filter((l) => !inherited.has(l.digest));
        }
      }
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
