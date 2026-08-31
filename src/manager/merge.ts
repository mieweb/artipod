/**
 * mergeHeads — the convergence half of the folder-sync CRDT (sync plan
 * Phase F, Decisions D8/D9). Pod state is a join-semilattice: blobs and
 * manifests form a G-Set (content-addressed — replication never conflicts);
 * the only mutable state is a ref head, and this is its join.
 *
 * Per path the join is last-writer-wins on `(mtimeMs, actor, layerDigest)`
 * — unless a D9 merger's glob matches, in which case the two sides'
 * BYTES merge (`resolve(a, b) → bytes`, e.g. Yjs `Y.mergeUpdates`; see
 * docs/sync.md) into a new layer. Resolvers must be deterministic,
 * commutative, associative, and idempotent — the property tests run
 * against every registered merger.
 *
 * Determinism/symmetry contract: same two heads in either order produce a
 * byte-identical merged manifest (canonical path sort, sorted parents,
 * symmetric clock rules), so digest equality IS the convergence test.
 * Losing layers stay reachable through `org.artipod.parents`.
 *
 * Metadata-first: views build from published index artifacts when present,
 * so merging two lazy heads moves no layer bytes except for paths a
 * content merger touches (or group layers that must split).
 */

import { sha256, isDigest, type Digest } from '../oci/digest.js';
import { gunzip, isGzip } from '../oci/gzip.js';
import { indexTar, parseLayerIndexArtifact, whiteoutTarget, ANNOTATION_LAYER_INDEX, type LayerEntry } from '../oci/tar.js';
import {
  buildFileLayer,
  ANNOTATION_ACTOR,
  ANNOTATION_MTIME,
  ANNOTATION_PARENTS,
} from '../oci/file-layer.js';
import { mergeLayerEntries } from '../oci/view.js';
import type { ImageManifest } from '../oci/pull.js';
import type { PodStore } from './pod-store.js';
import { pathGlobMatch } from './hydration.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type ContentMerger = (a: Uint8Array, b: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export interface MergeOptions {
  /** D9: first glob matching a conflicting path merges CONTENT instead of LWW. */
  mergers?: Record<string, ContentMerger>;
  /** Ancestor-walk cap (parents DAG). Default 1024 manifests. */
  maxWalk?: number;
}

export interface MergeResult {
  manifestDigest: Digest;
  /** 'a' / 'b' = fast-forward (one head already contains the other). */
  kind: 'a' | 'b' | 'merged';
  /** Conflicting paths resolved by LWW. */
  lwwPaths: string[];
  /** Conflicting paths resolved by a D9 content merger. */
  contentMergedPaths: string[];
}

type Manifests = Map<string, ImageManifest>;

async function loadManifest(store: PodStore, digest: Digest, cache: Manifests): Promise<ImageManifest> {
  const hit = cache.get(digest);
  if (hit) return hit;
  const manifest = JSON.parse(decoder.decode(await store.getBlob(digest))) as ImageManifest;
  cache.set(digest, manifest);
  return manifest;
}

function parentsOf(manifest: ImageManifest): Digest[] {
  const raw = manifest.annotations?.[ANNOTATION_PARENTS];
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as string[]).filter(isDigest);
  } catch {
    return [];
  }
}

/** True when `ancestor` is reachable from `head` through the parents DAG. */
export async function isAncestor(
  store: PodStore,
  ancestor: Digest,
  head: Digest,
  cache: Manifests = new Map(),
  maxWalk = 1024,
): Promise<boolean> {
  const queue: Digest[] = [head];
  const seen = new Set<string>();
  while (queue.length > 0 && seen.size < maxWalk) {
    const digest = queue.shift()!;
    if (digest === ancestor) return true;
    if (seen.has(digest)) continue;
    seen.add(digest);
    try {
      queue.push(...parentsOf(await loadManifest(store, digest, cache)));
    } catch {
      // missing manifest ends that branch of the walk
    }
  }
  return false;
}

/** Nearest common ancestor by BFS depth (null for unrelated histories). */
async function commonAncestor(
  store: PodStore,
  a: Digest,
  b: Digest,
  cache: Manifests,
  maxWalk: number,
): Promise<Digest | null> {
  const reach = async (head: Digest): Promise<Map<string, number>> => {
    const depths = new Map<string, number>();
    const queue: [Digest, number][] = [[head, 0]];
    while (queue.length > 0 && depths.size < maxWalk) {
      const [digest, depth] = queue.shift()!;
      if (depths.has(digest)) continue;
      depths.set(digest, depth);
      try {
        for (const parent of parentsOf(await loadManifest(store, digest, cache))) queue.push([parent, depth + 1]);
      } catch {
        // unreadable manifest ends the branch
      }
    }
    return depths;
  };
  const [da, db] = await Promise.all([reach(a), reach(b)]);
  let best: { digest: Digest; depth: number } | null = null;
  for (const [digest, depth] of da) {
    const other = db.get(digest);
    if (other === undefined) continue;
    const worst = Math.max(depth, other);
    if (!best || worst < best.depth) best = { digest: digest as Digest, depth: worst };
  }
  return best?.digest ?? null;
}

interface PathRegister {
  /** Winning file entry (never a whiteout). */
  entry: LayerEntry & { layer: number };
  descriptor: ImageManifest['layers'][number];
  diffId: string;
  /** Reusable as-is only when its layer holds exactly this file. */
  soleFileInLayer: boolean;
  mtimeMs: number;
  actor: string;
}

interface HeadView {
  files: Map<string, PathRegister>;
  /** path → whiteout stamp (ms) for clocked deletions. */
  whiteouts: Map<string, number>;
  manifest: ImageManifest;
}

async function layerEntriesFor(store: PodStore, layer: ImageManifest['layers'][number]): Promise<LayerEntry[]> {
  const indexDigest = layer.annotations?.[ANNOTATION_LAYER_INDEX];
  if (indexDigest && isDigest(indexDigest)) {
    try {
      return parseLayerIndexArtifact(decoder.decode(await store.getBlob(indexDigest))).entries;
    } catch {
      // fall through to the blob
    }
  }
  const compressed = await store.getBlob(layer.digest);
  return indexTar(isGzip(compressed) ? await gunzip(compressed) : compressed);
}

async function loadHeadView(store: PodStore, digest: Digest, cache: Manifests): Promise<HeadView> {
  const manifest = await loadManifest(store, digest, cache);
  const config = JSON.parse(decoder.decode(await store.getBlob(manifest.config.digest))) as {
    rootfs?: { diff_ids?: string[] };
  };
  const diffIds = config.rootfs?.diff_ids ?? [];
  const perLayer: LayerEntry[][] = [];
  for (const layer of manifest.layers) perLayer.push(await layerEntriesFor(store, layer));

  const whiteouts = new Map<string, number>();
  perLayer.forEach((entries) => {
    for (const e of entries) {
      const wh = whiteoutTarget(e.path);
      if (wh && wh.kind === 'delete') whiteouts.set(wh.target, Math.max(whiteouts.get(wh.target) ?? 0, e.mtimeMs));
    }
  });

  const merged = mergeLayerEntries(perLayer);
  const files = new Map<string, PathRegister>();
  const fileCount = perLayer.map((entries) => entries.filter((e) => e.type !== 'dir' && !whiteoutTarget(e.path)).length);
  for (const [path, entry] of merged.entries) {
    if (entry.type === 'dir') continue;
    const layer = manifest.layers[entry.layer];
    files.set(path, {
      entry,
      descriptor: layer,
      diffId: diffIds[entry.layer] ?? '',
      soleFileInLayer: fileCount[entry.layer] === 1,
      mtimeMs: entry.mtimeMs || Number(layer.annotations?.[ANNOTATION_MTIME] ?? 0),
      actor: layer.annotations?.[ANNOTATION_ACTOR] ?? '',
    });
  }
  return { files, whiteouts, manifest };
}

const sameEntry = (a: PathRegister, b: PathRegister) =>
  a.descriptor.digest === b.descriptor.digest && a.entry.offset === b.entry.offset && a.entry.size === b.entry.size;

/** Symmetric total order on registers: (mtime, actor, layerDigest, offset). */
function newerOf(a: PathRegister, b: PathRegister): PathRegister {
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs ? a : b;
  if (a.actor !== b.actor) return a.actor > b.actor ? a : b;
  if (a.descriptor.digest !== b.descriptor.digest) return a.descriptor.digest > b.descriptor.digest ? a : b;
  return a.entry.offset >= b.entry.offset ? a : b;
}

async function fileBytes(store: PodStore, reg: PathRegister): Promise<Uint8Array> {
  const compressed = await store.getBlob(reg.descriptor.digest);
  const tar = isGzip(compressed) ? await gunzip(compressed) : compressed;
  return tar.subarray(reg.entry.offset, reg.entry.offset + reg.entry.size);
}

/**
 * Join two heads. Fast-forwards when one contains the other; otherwise a
 * three-way per-path merge against the nearest common ancestor. The merged
 * manifest reuses existing per-file layers where possible; content-merged
 * paths and winners inside multi-file layers get fresh per-file layers.
 */
export async function mergeHeads(
  store: PodStore,
  headA: Digest,
  headB: Digest,
  options: MergeOptions = {},
): Promise<MergeResult> {
  const maxWalk = options.maxWalk ?? 1024;
  const cache: Manifests = new Map();
  if (headA === headB) return { manifestDigest: headA, kind: 'a', lwwPaths: [], contentMergedPaths: [] };
  if (await isAncestor(store, headB, headA, cache, maxWalk)) {
    return { manifestDigest: headA, kind: 'a', lwwPaths: [], contentMergedPaths: [] };
  }
  if (await isAncestor(store, headA, headB, cache, maxWalk)) {
    return { manifestDigest: headB, kind: 'b', lwwPaths: [], contentMergedPaths: [] };
  }

  const ancestorDigest = await commonAncestor(store, headA, headB, cache, maxWalk);
  const [viewA, viewB] = await Promise.all([loadHeadView(store, headA, cache), loadHeadView(store, headB, cache)]);
  const base = ancestorDigest ? await loadHeadView(store, ancestorDigest, cache) : { files: new Map<string, PathRegister>() };

  const mergerGlobs = Object.keys(options.mergers ?? {});
  const lwwPaths: string[] = [];
  const contentMergedPaths: string[] = [];

  interface Winner {
    reg?: PathRegister;
    /** Set for content merges (fresh bytes). */
    bytes?: Uint8Array;
    mtimeMs: number;
    actor: string;
    mode?: number;
  }
  const winners = new Map<string, Winner>();

  /** Deletion clock: whiteout stamp when present, else 0 (unclocked absence). */
  const deletionStamp = (view: HeadView, path: string): number => view.whiteouts.get(path) ?? 0;

  const paths = new Set<string>([...viewA.files.keys(), ...viewB.files.keys()]);
  for (const path of [...paths].sort()) {
    const a = viewA.files.get(path);
    const b = viewB.files.get(path);
    if (a && b) {
      if (sameEntry(a, b)) {
        // Same blob, but each head's DESCRIPTOR carries its own annotations
        // (actor etc.) — pick by the canonical order so A,B ≡ B,A.
        const pick = newerOf(a, b);
        winners.set(path, { reg: pick, mtimeMs: pick.mtimeMs, actor: pick.actor, mode: pick.entry.mode });
        continue;
      }
      const glob = mergerGlobs.find(
        // `**/x` also matches root-level `x` (the `**/` form needs a literal slash)
        (g) => pathGlobMatch(g, path) || (g.startsWith('**/') && pathGlobMatch(g.slice(3), path)),
      );
      if (glob) {
        const [bytesA, bytesB] = await Promise.all([fileBytes(store, a), fileBytes(store, b)]);
        // Symmetric argument order: the register order is canonical, not A/B.
        const [first, second] = newerOf(a, b) === a ? [bytesB, bytesA] : [bytesA, bytesB];
        const merged = await options.mergers![glob](first, second);
        winners.set(path, {
          bytes: merged,
          mtimeMs: Math.max(a.mtimeMs, b.mtimeMs),
          actor: [a.actor, b.actor].sort().join('+'),
          mode: newerOf(a, b).entry.mode,
        });
        contentMergedPaths.push(path);
      } else {
        const win = newerOf(a, b);
        winners.set(path, { reg: win, mtimeMs: win.mtimeMs, actor: win.actor, mode: win.entry.mode });
        lwwPaths.push(path);
      }
      continue;
    }
    // Present on one side only: added there, or deleted on the other.
    const present = (a ?? b)!;
    const otherView = a ? viewB : viewA;
    const inBase = base.files.get(path);
    if (!inBase) {
      winners.set(path, { reg: present, mtimeMs: present.mtimeMs, actor: present.actor, mode: present.entry.mode });
      continue;
    }
    // Deleted on the other side. Untouched-vs-delete → delete; edit-vs-delete → clocks.
    const edited = !sameEntry(present, inBase);
    const stamp = deletionStamp(otherView, path);
    if (!edited || stamp >= present.mtimeMs) {
      if (stamp > 0 || edited) lwwPaths.push(path); // deletion wins — path stays absent
      continue;
    }
    winners.set(path, { reg: present, mtimeMs: present.mtimeMs, actor: present.actor, mode: present.entry.mode });
    if (stamp > 0) lwwPaths.push(path);
  }

  // Build the merged manifest: canonical path order, one layer per file.
  const layers: ImageManifest['layers'] = [];
  const diffIds: string[] = [];
  const putIfAbsent = async (bytes: Uint8Array, digest: Digest) => {
    if (!(await store.hasBlob(digest))) await store.putBlob(bytes, digest);
  };
  // Local twins/indexes when the store supports them (browser OciStore).
  const rich = store as PodStore & {
    putUncompressed?: (d: Digest, b: Uint8Array) => Promise<void>;
    putLayerIndex?: (d: Digest, e: LayerEntry[]) => Promise<void>;
  };

  for (const [path, winner] of [...winners.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (winner.reg && winner.reg.soleFileInLayer && winner.reg.entry.type === 'file' && winner.reg.diffId) {
      // Zero-copy: reference the existing per-file layer.
      layers.push(winner.reg.descriptor);
      diffIds.push(winner.reg.diffId);
      continue;
    }
    // Fresh per-file layer: content merge output, or a winner split out of a multi-file layer.
    const bytes = winner.bytes ?? (await fileBytes(store, winner.reg!));
    const built = await buildFileLayer(
      [{ path, type: 'file', content: bytes, mode: winner.mode ?? 0o644, mtimeMs: winner.mtimeMs }],
      { path, mtimeMs: winner.mtimeMs, actor: winner.actor },
    );
    await putIfAbsent(built.compressed, built.layerDigest);
    await putIfAbsent(built.indexBytes, built.indexDigest);
    await rich.putUncompressed?.(built.diffId, built.tar);
    await rich.putLayerIndex?.(built.diffId, built.indexEntries);
    layers.push(built.descriptor);
    diffIds.push(built.diffId);
  }

  const config = encoder.encode(
    JSON.stringify({ artipod: { formatVersion: 1, publishedFrom: 'merge' }, rootfs: { type: 'layers', diff_ids: diffIds } }),
  );
  const configDigest = await sha256(config);
  await putIfAbsent(config, configDigest);

  const manifest: ImageManifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: config.length },
    layers,
    annotations: {
      [ANNOTATION_ACTOR]: 'merge',
      // Sorted parents keep merge(A,B) byte-identical to merge(B,A).
      [ANNOTATION_PARENTS]: JSON.stringify([headA, headB].sort()),
    },
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  const manifestDigest = await sha256(manifestBytes);
  await putIfAbsent(manifestBytes, manifestDigest);
  return { manifestDigest, kind: 'merged', lwwPaths, contentMergedPaths };
}
