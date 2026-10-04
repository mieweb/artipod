/**
 * publishDirectory — a real folder on the host becomes an artipod image in
 * a PodStore (sync plan Phase C, Decision D5): ONE LAYER PER FILE by
 * default, so hydrating "the whole layer" (layer-plan Decision #12) fetches
 * exactly the file a `cat` touched; `group` globs opt into coarser layers.
 * Every layer ships a published index artifact, so an index-level pull
 * lists the full tree with zero layer fetches.
 *
 * CRDT metadata (Decision D8): layers carry `(mtime, actor)` — the
 * per-path LWW register clock — and manifests link `org.artipod.parents`,
 * so heads form a DAG and republished losers stay reachable.
 *
 * Incremental republish is free via CAS: unchanged file → identical tar →
 * identical blob digest → skipped. Tar entry mtime IS the file mtime (it's
 * the LWW clock); determinism relies on gzip carrying no timestamp
 * (CompressionStream/zlib writes MTIME=0 — the fflate fallback would not,
 * but node ≥18 always has CompressionStream).
 */

import { readdir, readFile, lstat, mkdir, rm, writeFile, utimes, chmod, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { sha256, type Digest } from '../oci/digest.js';
import { gunzip, isGzip } from '../oci/gzip.js';
import { indexTar, type LayerEntry } from '../oci/tar.js';
import { mergeLayerEntries } from '../oci/view.js';
import { buildFileLayer, ANNOTATION_ACTOR, ANNOTATION_MTIME, ANNOTATION_PARENTS, ANNOTATION_PATH } from '../oci/file-layer.js';
import type { ImageManifest } from '../oci/pull.js';
import type { PodStore } from '../manager/pod-store.js';
import { pathGlobMatch } from '../manager/hydration.js';

export { ANNOTATION_ACTOR, ANNOTATION_MTIME, ANNOTATION_PARENTS, ANNOTATION_PATH };

export const DEFAULT_PUBLISH_IGNORE = ['node_modules/**', '.git/**', '.artipod/**', '.next/**'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface PublishDirectoryOptions {
  /** LWW identity on every layer. Default: `server:<hostname>`. */
  actor?: string;
  /** Globs routed into shared layers (first match wins) instead of one layer per file. */
  group?: string[];
  /** Relative-path globs to skip. Default: node_modules/.git/.artipod/.next. */
  ignore?: string[];
}

export interface PublishResult {
  manifestDigest: Digest;
  ref: string;
  layers: number;
  /** Layers whose blobs already existed in the store (CAS dedup). */
  reusedLayers: number;
  /** Compressed bytes newly written to the store. */
  bytes: number;
  /** Skipped symlinks, empty dirs, etc. */
  warnings: string[];
  /** True when the tree matched the current head exactly — ref untouched. */
  unchanged: boolean;
}

interface WalkedFile {
  /** Pod-absolute path ('/docs/a.md'). */
  path: string;
  rel: string;
  full: string;
  mode: number;
  mtimeMs: number;
}

function isIgnored(rel: string, patterns: string[]): boolean {
  return patterns.some((p) => pathGlobMatch(p, rel) || pathGlobMatch(`**/${p}`, rel));
}

async function walkDir(dir: string, ignore: string[], warnings: string[]): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  const visit = async (current: string, relBase: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    if (entries.length === 0 && relBase) warnings.push(`empty directory skipped: ${relBase}`);
    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (isIgnored(rel, ignore)) continue;
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        warnings.push(`symlink skipped: ${rel}`);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(full, rel);
      } else if (entry.isFile()) {
        const stats = await lstat(full);
        out.push({ path: `/${rel}`, rel, full, mode: stats.mode & 0o7777, mtimeMs: stats.mtimeMs });
      }
    }
  };
  await visit(dir, '');
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function defaultActor(): Promise<string> {
  const { hostname } = await import('node:os');
  return `server:${hostname()}`;
}

/**
 * Snapshot `dir` into `store` under `ref`. Re-publishing an unchanged tree
 * is a no-op (same manifest, ref untouched); otherwise the new manifest
 * records the previous head in `org.artipod.parents`.
 */
export async function publishDirectory(
  store: PodStore,
  dir: string,
  ref: string,
  options: PublishDirectoryOptions = {},
): Promise<PublishResult> {
  const warnings: string[] = [];
  const ignore = options.ignore ?? DEFAULT_PUBLISH_IGNORE;
  const actor = options.actor ?? (await defaultActor());
  const groups = options.group ?? [];
  const files = await walkDir(dir, ignore, warnings);

  // Bucket files: one glob group per matching set, one layer per remaining file.
  const groupBuckets = new Map<string, WalkedFile[]>();
  const singles: WalkedFile[] = [];
  for (const file of files) {
    const glob = groups.find((g) => pathGlobMatch(g, file.rel));
    if (glob) {
      const bucket = groupBuckets.get(glob) ?? [];
      bucket.push(file);
      groupBuckets.set(glob, bucket);
    } else {
      singles.push(file);
    }
  }
  const buckets: { files: WalkedFile[]; group?: string }[] = [
    ...[...groupBuckets.entries()].map(([group, f]) => ({ files: f, group })),
    ...singles.map((f) => ({ files: [f] })),
  ].sort((a, b) => (a.files[0].path < b.files[0].path ? -1 : 1));

  const layerDescriptors: ImageManifest['layers'] = [];
  const diffIds: Digest[] = [];
  let reusedLayers = 0;
  let bytes = 0;

  const putIfAbsent = async (blob: Uint8Array, digest: Digest): Promise<boolean> => {
    if (await store.hasBlob(digest)) return false;
    await store.putBlob(blob, digest);
    bytes += blob.length;
    return true;
  };

  for (const bucket of buckets) {
    const entries = [];
    for (const file of bucket.files) {
      entries.push({
        path: file.path,
        type: 'file' as const,
        content: new Uint8Array(await readFile(file.full)),
        mode: file.mode,
        mtimeMs: file.mtimeMs,
      });
    }
    const mtime = Math.max(...bucket.files.map((f) => f.mtimeMs));
    const layer = await buildFileLayer(entries, {
      path: bucket.group ?? bucket.files[0].path,
      mtimeMs: mtime,
      actor,
      group: bucket.group,
    });
    const wrote = await putIfAbsent(layer.compressed, layer.layerDigest);
    if (!wrote) reusedLayers += 1;
    await putIfAbsent(layer.indexBytes, layer.indexDigest);
    layerDescriptors.push(layer.descriptor);
    diffIds.push(layer.diffId);
  }

  const config = encoder.encode(
    JSON.stringify({ artipod: { formatVersion: 1, publishedFrom: 'directory' }, rootfs: { type: 'layers', diff_ids: diffIds } }),
  );
  const configDigest = await sha256(config);

  // Unchanged tree = same layers + config as the head → no-op republish
  // (a parents-only manifest every time would make no-ops grow the DAG).
  const head = await store.getRef(ref);
  if (head) {
    try {
      const headManifest = JSON.parse(decoder.decode(await store.getBlob(head.manifestDigest))) as ImageManifest;
      const sameLayers =
        headManifest.layers.length === layerDescriptors.length &&
        headManifest.layers.every((l, i) => l.digest === layerDescriptors[i].digest);
      if (sameLayers && headManifest.config.digest === configDigest) {
        return {
          manifestDigest: head.manifestDigest,
          ref,
          layers: layerDescriptors.length,
          reusedLayers,
          bytes,
          warnings,
          unchanged: true,
        };
      }
    } catch {
      warnings.push(`previous head manifest unreadable — publishing without comparison`);
    }
  }

  await putIfAbsent(config, configDigest);
  const manifest: ImageManifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: config.length },
    layers: layerDescriptors,
    annotations: {
      [ANNOTATION_ACTOR]: actor,
      ...(head ? { [ANNOTATION_PARENTS]: JSON.stringify([head.manifestDigest]) } : {}),
    },
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  const manifestDigest = await sha256(manifestBytes);
  await putIfAbsent(manifestBytes, manifestDigest);
  await store.putRef(ref, manifestDigest, manifest.mediaType!);

  return { manifestDigest, ref, layers: layerDescriptors.length, reusedLayers, bytes, warnings, unchanged: false };
}

// --- materialize (sync plan Phase E: browser layers land in the real folder) --

export interface MaterializeRefResult {
  written: number;
  deleted: number;
  skipped: number;
  warnings: string[];
}

async function loadMergedView(
  store: PodStore,
  manifestDigest: Digest,
): Promise<{ merged: ReturnType<typeof mergeLayerEntries>; bytesByLayer: Uint8Array[]; manifest: ImageManifest }> {
  const manifest = JSON.parse(decoder.decode(await store.getBlob(manifestDigest))) as ImageManifest;
  const layers: LayerEntry[][] = [];
  const bytesByLayer: Uint8Array[] = [];
  for (const layer of manifest.layers) {
    const compressed = await store.getBlob(layer.digest);
    const tar = isGzip(compressed) ? await gunzip(compressed) : compressed;
    layers.push(indexTar(tar));
    bytesByLayer.push(tar);
  }
  return { merged: mergeLayerEntries(layers), bytesByLayer, manifest };
}

/** '../'-free, non-absolute relative path or null. */
function safeRelPath(podPath: string): string | null {
  const rel = podPath.replace(/^\/+/, '');
  if (!rel || rel.split('/').some((s) => s === '..' || s === '' || s === '.')) return null;
  return rel;
}

/**
 * Write the ref's merged tree into a real directory: changed files land,
 * whiteout-deleted paths (vs the parent head) are removed, file mtimes come
 * from the tar entries so the next publishDirectory reproduces identical
 * blobs (the D7 loop-prevention round trip).
 *
 * Safety invariants (test-pinned): targets must resolve under `dir` after
 * symlink resolution of `dir` itself; traversal segments are rejected;
 * existing symlinks at a target are REPLACED, never followed.
 */
export async function materializeRef(store: PodStore, ref: string, dir: string): Promise<MaterializeRefResult> {
  const head = await store.getRef(ref);
  if (!head) throw new Error(`materializeRef: no such ref '${ref}'`);
  const realDir = await realpath(resolve(dir));
  const warnings: string[] = [];
  let written = 0;
  let deleted = 0;
  let skipped = 0;

  const { merged, bytesByLayer, manifest } = await loadMergedView(store, head.manifestDigest);

  const guard = (rel: string): string | null => {
    const target = resolve(realDir, rel);
    if (target !== realDir && !target.startsWith(realDir + sep)) return null;
    return target;
  };

  for (const [podPath, entry] of [...merged.entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.type === 'dir') continue;
    if (entry.type === 'symlink' || entry.type === 'hardlink') {
      warnings.push(`skipped ${entry.type}: ${podPath}`);
      skipped += 1;
      continue;
    }
    const rel = safeRelPath(podPath);
    const target = rel ? guard(rel) : null;
    if (!rel || !target) {
      warnings.push(`unsafe path refused: ${podPath}`);
      skipped += 1;
      continue;
    }
    const bytes = bytesByLayer[entry.layer].subarray(entry.offset, entry.offset + entry.size);
    const mtime = new Date(entry.mtimeMs || Number(manifest.layers[entry.layer]?.annotations?.[ANNOTATION_MTIME] ?? Date.now()));
    // skip identical content so untouched files keep their timestamps
    try {
      const stats = await lstat(target);
      if (stats.isSymbolicLink()) await rm(target); // never write through a link
      else if (stats.isFile() && stats.size === bytes.length && Math.floor(stats.mtimeMs / 1000) === Math.floor(mtime.getTime() / 1000)) {
        skipped += 1;
        continue;
      }
    } catch {
      // new file
    }
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, bytes);
    if (entry.mode) await chmod(target, entry.mode & 0o7777);
    await utimes(target, mtime, mtime);
    written += 1;
  }

  // Deletions: paths present in the parent head's view but absent now.
  const parents = manifest.annotations?.[ANNOTATION_PARENTS];
  if (parents) {
    for (const parentDigest of JSON.parse(parents) as Digest[]) {
      let parentView: Awaited<ReturnType<typeof loadMergedView>>;
      try {
        parentView = await loadMergedView(store, parentDigest);
      } catch {
        warnings.push(`parent ${parentDigest} unreadable — deletions vs it skipped`);
        continue;
      }
      for (const [podPath, entry] of parentView.merged.entries) {
        if (entry.type === 'dir' || merged.entries.has(podPath)) continue;
        const rel = safeRelPath(podPath);
        const target = rel ? guard(rel) : null;
        if (!rel || !target) continue;
        try {
          const stats = await lstat(target);
          if (!stats.isSymbolicLink()) {
            await rm(target);
            deleted += 1;
          }
        } catch {
          // already gone
        }
      }
    }
  }

  return { written, deleted, skipped, warnings };
}
