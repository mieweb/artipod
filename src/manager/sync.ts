/**
 * Anti-entropy sync (plan Phase 6): the blob set is add-only and
 * content-addressed — a convergent replicated set — so managers can sync in
 * any order/direction and converge. Only missing digests move; refs are
 * last-writer-wins pointers. Divergent writable uppers are BRANCHES,
 * resolved by explicit checkout/merge (none automatic in v1).
 */

import type { Digest } from '../oci/digest.js';
import type { ImageManifest } from '../oci/pull.js';
import type { ImageRef, OciTransport, ResolvedManifest } from '../oci/transport.js';
import { sha256, isDigest } from '../oci/digest.js';
import { ANNOTATION_LAYER_INDEX } from '../oci/tar.js';
import { mergeLayerEntries } from '../oci/view.js';
import { loadImageLayers } from '../oci/pull.js';
import type { OciStore } from '../oci/store.js';
import type { ZenFsLike } from '../sandbox/types.js';
import type { PodStore } from './pod-store.js';
import { AUDIT_MEDIA_TYPE, walkAuditDigests } from './audit.js';

const decoder = new TextDecoder();

/** Every digest an image ref reaches: manifest → config → layers → their
 * published index artifacts (annotation-referenced — index pulls need them). */
export async function walkImageDigests(store: PodStore, manifestDigest: Digest): Promise<Digest[]> {
  const digests: Digest[] = [manifestDigest];
  const manifest = JSON.parse(decoder.decode(await store.getBlob(manifestDigest))) as ImageManifest;
  if (manifest.config?.digest) digests.push(manifest.config.digest);
  for (const layer of manifest.layers ?? []) {
    digests.push(layer.digest);
    const indexDigest = layer.annotations?.[ANNOTATION_LAYER_INDEX];
    if (indexDigest && isDigest(indexDigest)) digests.push(indexDigest);
  }
  return digests;
}

export interface SyncResult {
  ref: string;
  manifestDigest: Digest;
  moved: number;
  skipped: number;
  movedBytes: number;
  /** false when a byte budget stopped the transfer before every blob moved. */
  complete: boolean;
  remaining: number;
}

export interface SyncOptions {
  /**
   * Bandwidth budget for this pass (constrained-link profiles). Blobs move
   * in priority order — manifest → config (small metadata) → bulk layers —
   * and blobs that would exceed the budget are left for the next pass (the
   * first blob always moves, guaranteeing progress). The ref pointer is only
   * written on completion; anti-entropy makes resume free (already-moved
   * digests skip). Sub-blob chunk-offset resume arrives with Phase 6.6 Range
   * support.
   */
  maxBytes?: number;
}

/** Copy one ref (and every blob it reaches) src → dst; only missing digests move. */
export async function syncRef(src: PodStore, dst: PodStore, ref: string, options: SyncOptions = {}): Promise<SyncResult> {
  const stored = await src.getRef(ref);
  if (!stored) throw new Error(`ref '${ref}' not found in the source store`);
  // Priority order: the walk yields metadata first (manifest, config), bulk
  // layer blobs after — audit chains are all-metadata by construction.
  const digests =
    stored.mediaType === AUDIT_MEDIA_TYPE
      ? await walkAuditDigests(src, stored.manifestDigest)
      : await walkImageDigests(src, stored.manifestDigest);
  let moved = 0;
  let skipped = 0;
  let movedBytes = 0;
  let remaining = 0;
  for (const digest of digests) {
    if (await dst.hasBlob(digest)) {
      skipped++;
      continue;
    }
    const bytes = await src.getBlob(digest);
    if (options.maxBytes !== undefined && movedBytes + bytes.length > options.maxBytes && moved + skipped > 0) {
      remaining++;
      continue;
    }
    await dst.putBlob(bytes, digest);
    moved++;
    movedBytes += bytes.length;
  }
  const complete = remaining === 0;
  if (complete) await dst.putRef(ref, stored.manifestDigest, stored.mediaType);
  return { ref, manifestDigest: stored.manifestDigest, moved, skipped, movedBytes, complete, remaining };
}

/** Sync every ref src → dst (manager-driven anti-entropy). */
export async function syncAllRefs(src: PodStore, dst: PodStore): Promise<SyncResult[]> {
  const out: SyncResult[] = [];
  for (const ref of await src.listRefs()) {
    out.push(await syncRef(src, dst, ref.ref));
  }
  return out;
}

/**
 * Present a PodStore as an OciTransport, so `pullImage` (verification,
 * decompress-once, indexing, skip-existing) is the ONE pull path for
 * registries and manager stores alike.
 */
export function storeTransport(store: PodStore): OciTransport {
  return {
    async resolve(ref: ImageRef, opts?: { digest?: Digest }): Promise<ResolvedManifest> {
      let digest = opts?.digest ?? ref.digest;
      let mediaType = 'application/vnd.oci.image.manifest.v1+json';
      if (!digest) {
        const candidates = [`${ref.host}/${ref.repo}:${ref.tag}`, `${ref.repo}:${ref.tag}`];
        if (ref.repo.startsWith('library/')) candidates.push(`${ref.repo.slice('library/'.length)}:${ref.tag}`);
        let stored = null;
        for (const name of candidates) {
          stored = await store.getRef(name);
          if (stored) break;
        }
        if (!stored) throw new Error(`ref '${candidates[candidates.length - 1]}' not found in the remote store`);
        digest = stored.manifestDigest;
        mediaType = stored.mediaType;
      }
      const bytes = await store.getBlob(digest);
      const manifestDigest = await sha256(bytes);
      if (manifestDigest !== digest) throw new Error(`store manifest ${digest} is corrupt`);
      return { manifestDigest, mediaType, bytes };
    },
    async fetchBlob(_ref: ImageRef, digest: Digest): Promise<Uint8Array> {
      return store.getBlob(digest);
    },
  };
}

export interface MaterializeOptions {
  store: OciStore;
  zfs: ZenFsLike;
  /** Image ref or manifest digest already present (and indexed) in the store. */
  refOrDigest: string;
  at: string;
}

/** Write an image's merged view into a directory as a writable tree (clone). */
export async function materializeImage(options: MaterializeOptions): Promise<{ at: string; files: number }> {
  const { store, zfs, at } = options;
  let manifestDigest: Digest;
  if (isDigest(options.refOrDigest)) {
    manifestDigest = options.refOrDigest;
  } else {
    const stored = await store.getRef(options.refOrDigest);
    if (!stored) throw new Error(`ref '${options.refOrDigest}' is not in this pod's store (pull it first)`);
    manifestDigest = stored.manifestDigest;
  }
  const { layers, layerBytes } = await loadImageLayers(store, manifestDigest);
  const merged = mergeLayerEntries(layers);
  await zfs.promises.mkdir(at, { recursive: true });
  let files = 0;
  for (const [path, entry] of [...merged.entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const dest = `${at}${path}`;
    if (entry.type === 'dir') {
      await zfs.promises.mkdir(dest, { recursive: true });
    } else if (entry.type === 'file' || entry.type === 'hardlink') {
      const source = entry.type === 'hardlink' && entry.linkTarget ? merged.entries.get(entry.linkTarget) : entry;
      const c = source && source.type === 'file' ? source : entry;
      const bytes = layerBytes[c.layer].subarray(c.offset, c.offset + c.size);
      await zfs.promises.mkdir(dest.slice(0, dest.lastIndexOf('/')) || '/', { recursive: true });
      await zfs.promises.writeFile(dest, bytes);
      files++;
    }
  }
  return { at, files };
}
