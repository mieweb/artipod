/**
 * Snapshots + commit = pod revision control (issue #1 steps 6–7).
 *
 * A snapshot is a MANIFEST REFERENCE, not a file copy: it points at a diff
 * layer (an ordinary indexed tar with OCI whiteouts for deletions) relative
 * to its parent snapshot, plus a cumulative index for O(1) diffing. The
 * whole Phase 4 machinery is reused — merge, whiteouts, layer indexes,
 * mounts — so `snapshot mount` is a zero-copy OciViewFS and `checkout`
 * materializes a new writable branch without ever touching history.
 *
 * `commit --tag` freezes the workspace into a single tar+gzip layer with a
 * volume-flavored image manifest — mountable by `artipod image mount` and
 *  pushable by Phase 6. `compact` squashes a chain; `gc` sweeps unreachable
 * digests and reports reclaimed bytes.
 */

import type { ZenFsLike } from '../sandbox/types.js';
import { sha256, type Digest } from './digest.js';
import { gzip } from './gzip.js';
import { indexTar, writeTar, whiteoutPathFor, type TarWriteEntry } from './tar.js';
import { OciStore, OCI_ROOT } from './store.js';
import { mergeLayerEntries, mountOciView } from './view.js';
import type { ImageManifest } from './pull.js';

export const SNAPSHOT_MEDIA_TYPE = 'application/vnd.artipod.snapshot.v1+json';
export const VOLUME_CONFIG_MEDIA_TYPE = 'application/vnd.artipod.volume.v1+json';

export type SnapshotOrigin = 'manual' | 'agent-turn' | 'compact';

export interface SnapshotManifest {
  formatVersion: 1;
  mediaType: typeof SNAPSHOT_MEDIA_TYPE;
  id: string;
  parent: string | null;
  createdAt: string;
  label?: string;
  origin: SnapshotOrigin;
  diff: { diffId: Digest; size: number; entryCount: number };
  roots: string[];
}

interface FileRecord {
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mode: number;
  contentDigest?: Digest;
  linkTarget?: string;
}

interface CumulativeIndex {
  formatVersion: 1;
  files: Record<string, FileRecord>;
}

export interface SnapshotDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

export interface SnapshotManagerOptions {
  zfs: ZenFsLike;
  store: OciStore;
  /** Workspace roots to capture (the pod's rw mount paths). */
  roots: string[];
  /** Path prefixes never captured (store, /proc, view mounts, branches…). */
  exclude?: string[];
}

const SNAP_DIR = `${OCI_ROOT}/snapshots`;
const DEFAULT_EXCLUDE = ['/.artipod', '/proc', '/mnt', '/dev', '/branches'];

function snapshotId(): string {
  const buf = new Uint8Array(6);
  globalThis.crypto.getRandomValues(buf);
  return `snap-${Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const asBytes = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

export class SnapshotManager {
  private readonly zfs: ZenFsLike;
  private readonly store: OciStore;
  private readonly roots: string[];
  private readonly exclude: string[];

  constructor(options: SnapshotManagerOptions) {
    this.zfs = options.zfs;
    this.store = options.store;
    this.roots = options.roots;
    this.exclude = [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])];
  }

  private get p() {
    return this.zfs.promises;
  }

  private excluded(path: string): boolean {
    return this.exclude.some((e) => path === e || path.startsWith(`${e}/`));
  }

  // --- workspace walk ---------------------------------------------------------

  private async walk(): Promise<Map<string, FileRecord & { bytes?: Uint8Array }>> {
    const out = new Map<string, FileRecord & { bytes?: Uint8Array }>();
    const visit = async (dir: string): Promise<void> => {
      let names: string[];
      try {
        names = (await this.p.readdir(dir)) as string[];
      } catch {
        return;
      }
      for (const name of names) {
        const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
        if (this.excluded(path)) continue;
        let stat;
        try {
          stat = await this.p.stat(path);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          out.set(path, { type: 'dir', size: 0, mode: 0o755 });
          await visit(path);
        } else if (stat.isFile()) {
          const bytes = asBytes((await this.p.readFile(path)) as Uint8Array);
          out.set(path, { type: 'file', size: bytes.length, mode: 0o644, contentDigest: await sha256(bytes), bytes });
        }
      }
    };
    for (const root of this.roots) await visit(root === '/' ? '/' : root);
    return out;
  }

  // --- persistence ------------------------------------------------------------

  private manifestPath(id: string): string {
    return `${SNAP_DIR}/${id}.json`;
  }

  private indexPath(id: string): string {
    return `${SNAP_DIR}/${id}.index.json`;
  }

  private async readHead(): Promise<string | null> {
    try {
      return ((await this.p.readFile(`${SNAP_DIR}/HEAD`, 'utf8')) as string).trim() || null;
    } catch {
      return null;
    }
  }

  private async writeHead(id: string): Promise<void> {
    await this.p.writeFile(`${SNAP_DIR}/HEAD`, id);
  }

  async get(id: string): Promise<SnapshotManifest> {
    return JSON.parse((await this.p.readFile(this.manifestPath(id), 'utf8')) as string) as SnapshotManifest;
  }

  private async cumulativeIndex(id: string): Promise<CumulativeIndex> {
    return JSON.parse((await this.p.readFile(this.indexPath(id), 'utf8')) as string) as CumulativeIndex;
  }

  async list(): Promise<SnapshotManifest[]> {
    let names: string[];
    try {
      names = (await this.p.readdir(SNAP_DIR)) as string[];
    } catch {
      return [];
    }
    const out: SnapshotManifest[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.index.json')) continue;
      try {
        out.push(JSON.parse((await this.p.readFile(`${SNAP_DIR}/${name}`, 'utf8')) as string) as SnapshotManifest);
      } catch {
        // skip corrupt
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // --- create -----------------------------------------------------------------

  /**
   * Capture the workspace as a diff layer against HEAD. Reference-based:
   * unchanged content is never stored twice (dedup by content digest at the
   * layer level; unchanged files simply aren't in the diff).
   */
  async create(options: { label?: string; origin?: SnapshotOrigin; skipIfClean?: boolean } = {}): Promise<SnapshotManifest | null> {
    const origin = options.origin ?? 'manual';
    const parentId = await this.readHead();
    const parent = parentId ? await this.cumulativeIndex(parentId) : { formatVersion: 1 as const, files: {} };
    const current = await this.walk();

    const tarEntries: TarWriteEntry[] = [];
    const cumulative: CumulativeIndex = { formatVersion: 1, files: {} };
    let changes = 0;

    for (const [path, record] of current) {
      const prev = parent.files[path];
      const changed =
        !prev ||
        prev.type !== record.type ||
        prev.contentDigest !== record.contentDigest ||
        prev.linkTarget !== record.linkTarget;
      if (changed) {
        changes++;
        tarEntries.push({
          path,
          type: record.type,
          content: record.bytes,
          mode: record.mode,
          linkTarget: record.linkTarget,
        });
      }
      cumulative.files[path] = { type: record.type, size: record.size, mode: record.mode, contentDigest: record.contentDigest, linkTarget: record.linkTarget };
    }
    for (const path of Object.keys(parent.files)) {
      if (!current.has(path)) {
        changes++;
        tarEntries.push({ path: whiteoutPathFor(path), type: 'file' });
      }
    }

    if (changes === 0 && options.skipIfClean) return null;

    const tar = writeTar(tarEntries);
    const diffId = await sha256(tar);
    await this.store.putUncompressed(diffId, tar);
    await this.store.putLayerIndex(diffId, indexTar(tar));

    const manifest: SnapshotManifest = {
      formatVersion: 1,
      mediaType: SNAPSHOT_MEDIA_TYPE,
      id: snapshotId(),
      parent: parentId,
      createdAt: new Date().toISOString(),
      label: options.label,
      origin,
      diff: { diffId, size: tar.length, entryCount: tarEntries.length },
      roots: [...this.roots],
    };
    await this.p.mkdir(SNAP_DIR, { recursive: true });
    await this.p.writeFile(this.manifestPath(manifest.id), JSON.stringify(manifest, null, 2));
    await this.p.writeFile(this.indexPath(manifest.id), JSON.stringify(cumulative));
    await this.writeHead(manifest.id);
    return manifest;
  }

  // --- chain helpers ----------------------------------------------------------

  private async chain(id: string): Promise<SnapshotManifest[]> {
    const chain: SnapshotManifest[] = [];
    let cursor: string | null = id;
    while (cursor) {
      const manifest: SnapshotManifest = await this.get(cursor);
      chain.unshift(manifest);
      cursor = manifest.parent;
    }
    return chain;
  }

  private async loadChainLayers(id: string) {
    const chain = await this.chain(id);
    const layers = [];
    const layerBytes = [];
    for (const snap of chain) {
      layers.push((await this.store.getLayerIndex(snap.diff.diffId)).entries);
      layerBytes.push(await this.store.getUncompressed(snap.diff.diffId));
    }
    return { chain, layers, layerBytes };
  }

  // --- diff -------------------------------------------------------------------

  /** Diff two snapshots (or a snapshot against the live worktree). */
  async diff(fromId: string, toId?: string): Promise<SnapshotDiff> {
    const from = (await this.cumulativeIndex(fromId)).files;
    let to: Record<string, FileRecord>;
    if (toId) {
      to = (await this.cumulativeIndex(toId)).files;
    } else {
      to = {};
      for (const [path, record] of await this.walk()) {
        to[path] = { type: record.type, size: record.size, mode: record.mode, contentDigest: record.contentDigest, linkTarget: record.linkTarget };
      }
    }
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [path, record] of Object.entries(to)) {
      const prev = from[path];
      if (!prev) added.push(path);
      else if (prev.type !== record.type || prev.contentDigest !== record.contentDigest || prev.linkTarget !== record.linkTarget) modified.push(path);
    }
    for (const path of Object.keys(from)) {
      if (!(path in to)) deleted.push(path);
    }
    return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
  }

  // --- checkout / mount -------------------------------------------------------

  /** Zero-copy read-only mount of a snapshot's merged chain. */
  async mount(id: string, at?: string): Promise<{ at: string; unmount: () => void }> {
    const target = at ?? `/mnt/snapshots/${id}`;
    const { layers, layerBytes } = await this.loadChainLayers(id);
    const unmount = await mountOciView({ zfs: this.zfs, at: target, layers, layerBytes, name: id });
    return { at: target, unmount };
  }

  /**
   * Materialize a NEW writable branch from a snapshot (git-checkout-like);
   * later history is never destroyed — HEAD does not move.
   */
  async checkout(id: string, at?: string): Promise<string> {
    const target = at ?? `/branches/${id}`;
    const { layers } = await this.loadChainLayers(id);
    const bytesByLayer = await Promise.all(
      (await this.chain(id)).map((s) => this.store.getUncompressed(s.diff.diffId)),
    );
    const merged = mergeLayerEntries(layers);
    await this.p.mkdir(target, { recursive: true });
    for (const [path, entry] of [...merged.entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const dest = `${target}${path}`;
      if (entry.type === 'dir') {
        await this.p.mkdir(dest, { recursive: true });
      } else if (entry.type === 'file') {
        const bytes = bytesByLayer[entry.layer].subarray(entry.offset, entry.offset + entry.size);
        await this.p.mkdir(dest.slice(0, dest.lastIndexOf('/')) || '/', { recursive: true });
        await this.p.writeFile(dest, bytes);
      }
      // symlinks/hardlinks in workspace snapshots are rare; files carry content
    }
    return target;
  }

  // --- commit -----------------------------------------------------------------

  /** Freeze the live workspace into a tagged single-layer volume image. */
  async commit(tag: string): Promise<{ manifestDigest: Digest; diffId: Digest; size: number }> {
    const current = await this.walk();
    const tarEntries: TarWriteEntry[] = [...current.entries()].map(([path, r]) => ({
      path,
      type: r.type,
      content: r.bytes,
      mode: r.mode,
      linkTarget: r.linkTarget,
    }));
    const tar = writeTar(tarEntries);
    const diffId = await sha256(tar);
    const compressed = await gzip(tar);
    const layerDigest = await sha256(compressed);
    await this.store.putBlob(compressed, layerDigest);
    await this.store.putUncompressed(diffId, tar);
    await this.store.putLayerIndex(diffId, indexTar(tar));

    const config = new TextEncoder().encode(
      JSON.stringify({ artipod: { formatVersion: 1, roots: this.roots }, rootfs: { type: 'layers', diff_ids: [diffId] } }),
    );
    const configDigest = await sha256(config);
    await this.store.putBlob(config, configDigest);

    const manifest: ImageManifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: VOLUME_CONFIG_MEDIA_TYPE, digest: configDigest, size: config.length },
      layers: [
        { mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: layerDigest, size: compressed.length },
      ],
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestDigest = await sha256(manifestBytes);
    await this.store.putBlob(manifestBytes, manifestDigest);
    await this.store.putRef(tag, manifestDigest, manifest.mediaType!);
    return { manifestDigest, diffId, size: compressed.length };
  }

  // --- compact + gc -----------------------------------------------------------

  /** Squash HEAD's chain into one diff layer (superseded blobs become gc-able). */
  async compact(): Promise<SnapshotManifest> {
    const headId = await this.readHead();
    if (!headId) throw new Error('nothing to compact — no snapshots yet');
    const { chain, layers } = await this.loadChainLayers(headId);
    if (chain.length === 1) return chain[0];
    const bytesByLayer = await Promise.all(chain.map((s) => this.store.getUncompressed(s.diff.diffId)));
    const merged = mergeLayerEntries(layers);

    const tarEntries: TarWriteEntry[] = [...merged.entries.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, entry]) => ({
        path,
        type: entry.type === 'hardlink' ? 'file' : entry.type,
        content:
          entry.type === 'file'
            ? bytesByLayer[entry.layer].subarray(entry.offset, entry.offset + entry.size)
            : undefined,
        mode: entry.mode,
        linkTarget: entry.linkTarget,
      }));
    const tar = writeTar(tarEntries);
    const diffId = await sha256(tar);
    await this.store.putUncompressed(diffId, tar);
    await this.store.putLayerIndex(diffId, indexTar(tar));

    const head = chain[chain.length - 1];
    const manifest: SnapshotManifest = {
      formatVersion: 1,
      mediaType: SNAPSHOT_MEDIA_TYPE,
      id: snapshotId(),
      parent: null,
      createdAt: new Date().toISOString(),
      label: `compact of ${chain.length} snapshots${head.label ? ` (${head.label})` : ''}`,
      origin: 'compact',
      diff: { diffId, size: tar.length, entryCount: tarEntries.length },
      roots: [...this.roots],
    };
    await this.p.writeFile(this.manifestPath(manifest.id), JSON.stringify(manifest, null, 2));
    const headIndex = await this.cumulativeIndex(headId);
    await this.p.writeFile(this.indexPath(manifest.id), JSON.stringify(headIndex));
    await this.writeHead(manifest.id);
    for (const snap of chain) {
      await this.p.rm(this.manifestPath(snap.id), { force: true });
      await this.p.rm(this.indexPath(snap.id), { force: true });
    }
    return manifest;
  }

  /** Mark-and-sweep unreachable digests; returns reclaimed byte counts. */
  async gc(): Promise<{ deleted: number; reclaimedBytes: number }> {
    const reachableHex = new Set<string>();
    const markDigest = (d: string | undefined) => {
      if (d?.startsWith('sha256:')) reachableHex.add(d.slice(7));
    };

    for (const snap of await this.list()) markDigest(snap.diff.diffId);

    const decoder = new TextDecoder();
    for (const ref of await this.store.listRefs()) {
      markDigest(ref.manifestDigest);
      try {
        const manifest = JSON.parse(decoder.decode(await this.store.getBlob(ref.manifestDigest))) as ImageManifest;
        markDigest(manifest.config?.digest);
        for (const layer of manifest.layers ?? []) markDigest(layer.digest);
        const config = JSON.parse(decoder.decode(await this.store.getBlob(manifest.config.digest))) as {
          rootfs?: { diff_ids?: string[] };
        };
        for (const d of config.rootfs?.diff_ids ?? []) markDigest(d);
      } catch {
        // unreadable manifests keep only themselves
      }
    }

    let deleted = 0;
    let reclaimedBytes = 0;
    for (const dir of ['blobs/sha256', 'uncompressed/sha256', 'indexes/sha256']) {
      let names: string[];
      try {
        names = (await this.p.readdir(`${OCI_ROOT}/${dir}`)) as string[];
      } catch {
        continue;
      }
      for (const name of names) {
        const hex = name.replace(/\.(json|alias)$/, '');
        if (reachableHex.has(hex)) continue;
        const path = `${OCI_ROOT}/${dir}/${name}`;
        try {
          const stat = await this.p.stat(path);
          reclaimedBytes += stat.size;
          await this.p.rm(path, { force: true });
          deleted++;
        } catch {
          // already gone
        }
      }
    }
    return { deleted, reclaimedBytes };
  }
}
