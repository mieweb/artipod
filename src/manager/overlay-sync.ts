/**
 * Overlay write-back (sync plan Phase E, Decision D7): the CoW upper of an
 * opened basis becomes appended per-file layers on the ref's head —
 * `echo hi > testfile.txt` really does upload a new layer, `rm` uploads a
 * whiteout. The new head keeps the basis layers verbatim (placeholders
 * stay lazy for every other client) and links the previous head through
 * `org.artipod.parents`; anti-entropy `syncRef` then moves only the new
 * blobs (the server already holds the basis).
 *
 * Convergence note (until Phase F's merge): pushes fast-forward the shared
 * ref; a concurrent remote head is overwritten but stays reachable via the
 * parents DAG — nothing is ever lost, F adds the per-path LWW merge.
 */

import { sha256, type Digest } from '../oci/digest.js';
import {
  buildFileLayer,
  ANNOTATION_ACTOR,
  ANNOTATION_OVERLAY,
  ANNOTATION_PARENTS,
} from '../oci/file-layer.js';
import { whiteoutPathFor, type TarWriteEntry } from '../oci/tar.js';
import type { ImageManifest } from '../oci/pull.js';
import type { OciStore } from '../oci/store.js';
import type { ZenFsLike } from '../sandbox/types.js';
import type { PodStore } from './pod-store.js';
import { syncRef, type SyncResult } from './sync.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface OverlayHeadOptions {
  store: OciStore;
  zfs: ZenFsLike;
  ref: string;
  /** Where the overlay's writable upper is mounted (hydrator.overlays). */
  upperAt: string;
  /** Deleted pod paths → deletion timestamp (the whiteout LWW clock). */
  deletions: Map<string, number>;
  actor: string;
  /**
   * Publish semantics: mint layers WITHOUT the overlay annotation, so they
   * become part of the permanent base — a later (even empty) overlay push by
   * the same actor cannot strip them. Use when the upper is retired after
   * the push (blank publish, publish-as).
   */
  permanent?: boolean;
}

export interface OverlayHeadResult {
  changed: boolean;
  manifestDigest: Digest;
  /** Overlay layers on the new head (files + whiteout layer when present). */
  overlayLayers: number;
}

interface UpperFile {
  podPath: string;
  content: Uint8Array;
  mode: number;
  mtimeMs: number;
}

async function walkUpper(zfs: ZenFsLike, upperAt: string): Promise<UpperFile[]> {
  const p = zfs.promises;
  const out: UpperFile[] = [];
  const visit = async (dir: string, rel: string): Promise<void> => {
    let names: string[];
    try {
      names = (await p.readdir(dir)) as string[];
    } catch {
      return;
    }
    for (const name of names) {
      const full = `${dir}/${name}`;
      const podPath = `${rel}/${name}`;
      const stats = await p.stat(full);
      if (stats.isDirectory()) {
        await visit(full, podPath);
      } else if (stats.isFile()) {
        const raw = (await p.readFile(full)) as Uint8Array;
        out.push({
          podPath,
          content: new Uint8Array(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength),
          mode: Number(stats.mode) & 0o7777,
          mtimeMs: Number(stats.mtimeMs),
        });
      }
    }
  };
  await visit(upperAt, '');
  return out.sort((a, b) => (a.podPath < b.podPath ? -1 : 1));
}

/**
 * Rebuild the ref's head from (current head minus our previous overlay
 * layers) + one per-file layer per upper file + one whiteout layer.
 * Deterministic for a given upper state, so a re-push is a no-op.
 */
export async function buildOverlayHead(options: OverlayHeadOptions): Promise<OverlayHeadResult> {
  const { store, zfs, ref, upperAt, deletions, actor, permanent } = options;
  const head = await store.getRef(ref);
  if (!head) throw new Error(`overlay push: no local head for '${ref}' — open it first`);
  const headManifest = JSON.parse(decoder.decode(await store.getBlob(head.manifestDigest))) as ImageManifest;
  const headConfig = JSON.parse(decoder.decode(await store.getBlob(headManifest.config.digest))) as {
    rootfs?: { diff_ids?: string[] };
  };
  const headDiffIds = headConfig.rootfs?.diff_ids ?? [];

  // Base = the head without OUR previous overlay layers (replaced wholesale).
  const baseLayers: ImageManifest['layers'] = [];
  const baseDiffIds: string[] = [];
  headManifest.layers.forEach((layer, i) => {
    if (layer.annotations?.[ANNOTATION_OVERLAY] === actor) return;
    baseLayers.push(layer);
    baseDiffIds.push(headDiffIds[i]);
  });

  const layers = [...baseLayers];
  const diffIds = [...baseDiffIds];
  let overlayLayers = 0;

  const putLayer = async (built: Awaited<ReturnType<typeof buildFileLayer>>) => {
    if (!(await store.hasBlob(built.layerDigest))) await store.putBlob(built.compressed, built.layerDigest);
    await store.putUncompressed(built.diffId, built.tar);
    await store.putLayerIndex(built.diffId, built.indexEntries);
    if (!(await store.hasBlob(built.indexDigest))) await store.putBlob(built.indexBytes, built.indexDigest);
    layers.push(built.descriptor);
    diffIds.push(built.diffId);
    overlayLayers += 1;
  };

  for (const file of await walkUpper(zfs, upperAt)) {
    await putLayer(
      await buildFileLayer(
        [{ path: file.podPath, type: 'file', content: file.content, mode: file.mode, mtimeMs: file.mtimeMs }],
        { path: file.podPath, mtimeMs: file.mtimeMs, actor, ...(permanent ? {} : { overlay: actor }) },
      ),
    );
  }

  const deleted = [...deletions.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  if (deleted.length > 0) {
    const entries: TarWriteEntry[] = deleted.map(([path, stamp]) => ({
      path: whiteoutPathFor(path),
      type: 'file',
      content: new Uint8Array(0),
      mtimeMs: stamp,
    }));
    const stamp = Math.max(...deleted.map(([, s]) => s));
    await putLayer(await buildFileLayer(entries, { path: '.wh', mtimeMs: stamp, actor, ...(permanent ? {} : { overlay: actor }) }));
  }

  const config = encoder.encode(
    JSON.stringify({ artipod: { formatVersion: 1, publishedFrom: 'overlay' }, rootfs: { type: 'layers', diff_ids: diffIds } }),
  );
  const configDigest = await sha256(config);

  // Same layers + config as the head = nothing to push.
  const same =
    headManifest.layers.length === layers.length &&
    headManifest.layers.every((l, i) => l.digest === layers[i].digest) &&
    headManifest.config.digest === configDigest;
  if (same) return { changed: false, manifestDigest: head.manifestDigest, overlayLayers };

  if (!(await store.hasBlob(configDigest))) await store.putBlob(config, configDigest);
  const manifest: ImageManifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: config.length },
    layers,
    annotations: {
      [ANNOTATION_ACTOR]: actor,
      [ANNOTATION_PARENTS]: JSON.stringify([head.manifestDigest]),
    },
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  const manifestDigest = await sha256(manifestBytes);
  if (!(await store.hasBlob(manifestDigest))) await store.putBlob(manifestBytes, manifestDigest);
  await store.putRef(ref, manifestDigest, manifest.mediaType!);
  return { changed: true, manifestDigest, overlayLayers };
}

export interface OverlayPushResult {
  pushed: boolean;
  manifestDigest: Digest;
  overlayLayers: number;
  sync?: SyncResult;
}

/** Build the overlay head locally, then anti-entropy it to the manager. */
export async function pushOverlay(
  options: OverlayHeadOptions & { remote: PodStore },
): Promise<OverlayPushResult> {
  const head = await buildOverlayHead(options);
  if (!head.changed) {
    // Nothing new locally. Retry the transfer only when the remote is
    // missing or strictly behind us — pushing an unchanged head at a
    // remote that MOVED would regress it (merge-on-push protects wired
    // remotes, but plain stores take putRef literally).
    const remoteRef = await options.remote.getRef(options.ref);
    if (remoteRef?.manifestDigest === head.manifestDigest) {
      return { pushed: false, manifestDigest: head.manifestDigest, overlayLayers: head.overlayLayers };
    }
    if (remoteRef) {
      const { isAncestor } = await import('./merge.js');
      const behind = await isAncestor(options.store, remoteRef.manifestDigest, head.manifestDigest);
      if (!behind) {
        return { pushed: false, manifestDigest: head.manifestDigest, overlayLayers: head.overlayLayers };
      }
    }
  }
  const sync = await syncRef(options.store, options.remote, options.ref);
  return { pushed: true, manifestDigest: head.manifestDigest, overlayLayers: head.overlayLayers, sync };
}
