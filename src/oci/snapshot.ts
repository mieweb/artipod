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
import { sha256, isDigest, type Digest } from './digest.js';
import { gzip } from './gzip.js';
import { indexTar, writeTar, whiteoutPathFor, makeLayerIndexArtifact, ANNOTATION_HYDRATION, ANNOTATION_LAYER_INDEX, ANNOTATION_LAYER_GROUP, type TarWriteEntry } from './tar.js';
import { OciStore, OCI_ROOT, assertOciStoreStorage } from './store.js';
import { ANNOTATION_PARENTS } from './file-layer.js';
import { AUDIT_MEDIA_TYPE } from '../manager/audit.js';
import { mergeLayerEntries, mountOciView } from './view.js';
import type { ImageManifest } from './pull.js';
import { pathGlobMatch } from '../manager/hydration.js';
import { resolveStorageAccess, type StorageAccessOptions } from '../storage/context.js';

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
  /** Modes of captured root directories (older snapshots omit these). */
  rootModes?: Record<string, number>;
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

export interface SnapshotManagerOptions extends StorageAccessOptions {
  zfs: ZenFsLike;
  store: OciStore;
  /** Workspace roots to capture (the pod's rw mount paths). */
  roots: string[];
  /** Path prefixes never captured (store, /proc, view mounts, branches…). */
  exclude?: string[];
  /** Override broad CLI exclusions for full local workspace checkpoints. */
  defaultExcludes?: boolean;
  /** Native host fs adapter when ZenFS emulates links or caches host metadata. */
  workspaceFs?: SnapshotFilesystem;
}

export interface SnapshotFilesystem {
  promises: ZenFsLike['promises'];
  /** Reject distinct snapshot paths that alias on the materialization volume. */
  validateSnapshotPaths?: (paths: readonly string[], options?: { destination?: string }) => Promise<void>;
}

export interface SnapshotRestoreChange {
  path: string;
  type: 'created' | 'changed' | 'deleted';
  kind: 'file' | 'directory' | 'symlink';
}

const SNAP_DIR = `${OCI_ROOT}/snapshots`;
const RESERVED_ROOTS = ['/.artipod', '/proc'];
const DEFAULT_EXCLUDE = [...RESERVED_ROOTS, '/mnt', '/dev', '/branches'];

/** Native host volumes may alias case variants of metadata/runtime roots. */
function reservedPath(path: string): boolean {
  const folded = path.toLowerCase();
  return RESERVED_ROOTS.some(root => folded === root || folded.startsWith(`${root}/`));
}

function snapshotId(): string {
  const buf = new Uint8Array(6);
  globalThis.crypto.getRandomValues(buf);
  return `snap-${Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const asBytes = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
const missing = (error: unknown): boolean => (error as { code?: string })?.code === 'ENOENT';
const validSymlinkTarget = (target: unknown): target is string => typeof target === 'string' && target.length > 0 && !target.includes('\0');

export class SnapshotManager {
  private readonly zfs: ZenFsLike;
  private readonly store: OciStore;
  private readonly roots: string[];
  private readonly exclude: string[];
  private readonly heldWorkspaceFs: SnapshotFilesystem;
  private readonly storageOptions: StorageAccessOptions;

  constructor(options: SnapshotManagerOptions) {
    const storage = resolveStorageAccess(options.zfs, options);
    if (storage && storage.protection !== 'plaintext' && options.workspaceFs && options.workspaceFs !== options.zfs) throw new Error('Protected snapshots must use the owning core storage filesystem');
    if (storage && storage.protection !== 'plaintext') assertOciStoreStorage(options.store, storage);
    this.zfs = options.zfs;
    this.storageOptions = Object.freeze({ storage, storagePolicy: options.storagePolicy });
    this.store = options.store;
    this.roots = options.roots;
    this.exclude = [...(options.defaultExcludes === false ? RESERVED_ROOTS : DEFAULT_EXCLUDE), ...(options.exclude ?? [])];
    this.heldWorkspaceFs = options.workspaceFs ?? options.zfs;
  }

  private get p() {
    this.assertStorageAccess();
    return this.zfs.promises;
  }

  private get workspaceFs(): SnapshotFilesystem {
    this.assertStorageAccess();
    return this.heldWorkspaceFs;
  }

  private assertStorageAccess(): void {
    const storage = resolveStorageAccess(this.zfs, this.storageOptions);
    if (storage && storage.protection !== 'plaintext') assertOciStoreStorage(this.store, storage);
  }

  /** Create directory components without following an existing symlink alias. */
  private async ensureDirectory(directory: string): Promise<void> {
    const p = this.workspaceFs.promises;
    let prefix = '';
    for (const component of directory.split('/').slice(1)) {
      if (!component) continue;
      prefix += `/${component}`;
      try { await p.mkdir(prefix); }
      catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
      }
      const info = await p.lstat(prefix);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Snapshot materialization requires real directories: ${prefix}`);
    }
  }

  private excluded(path: string): boolean {
    return reservedPath(path) || this.exclude.some((e) => path === e || path.startsWith(`${e}/`));
  }

  // --- workspace walk ---------------------------------------------------------

  private async walk(filesystem = this.workspaceFs, { allowEmptySymlinkTargets = false, retainedAncestors }: { allowEmptySymlinkTargets?: boolean; retainedAncestors?: Set<string> } = {}): Promise<Map<string, FileRecord & { bytes?: Uint8Array }>> {
    const p = filesystem.promises;
    // A saved tree can be valid while a live root has been redirected. Check
    // every root component before readdir/readFile can follow it outside the
    // capture boundary, and before restore can delete any enumerated entries.
    const directories = new Set(['/']);
    for (const root of this.roots) {
      let prefix = '';
      for (const component of root.split('/').slice(1)) {
        if (!component) continue;
        prefix += `/${component}`;
        directories.add(prefix);
      }
    }
    for (const directory of directories) {
      const info = await p.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Snapshot root and ancestors must be real directories: ${directory}`);
    }
    const out = new Map<string, FileRecord & { bytes?: Uint8Array }>();
    const visit = async (dir: string): Promise<void> => {
      for (const name of (await p.readdir(dir) as string[]).sort()) {
        const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
        if (this.excluded(path)) {
          // Excluded entries are deliberately retained. Their real, traversed
          // ancestors cannot be removed even when absent from the saved tree.
          let ancestor = dir;
          while (retainedAncestors && ancestor !== '/') {
            retainedAncestors.add(ancestor);
            ancestor = ancestor.slice(0, ancestor.lastIndexOf('/')) || '/';
          }
          continue;
        }
        this.validatePath(path);
        if (name.startsWith('.wh.')) throw new Error(`Unsupported workspace entry (OCI whiteout name): ${path}`);
        const stat = await p.lstat(path);
        const mode = stat.mode & 0o777;
        if (stat.isSymbolicLink()) {
          const linkTarget = await p.readlink(path);
          if (!validSymlinkTarget(linkTarget) && !(allowEmptySymlinkTargets && linkTarget === '')) throw new Error(`Invalid Artipod snapshot symlink: ${path}`);
          out.set(path, { type: 'symlink', size: 0, mode, linkTarget });
        } else if (stat.isDirectory()) {
          out.set(path, { type: 'dir', size: 0, mode });
          await visit(path);
        } else if (stat.isFile()) {
          const bytes = asBytes(await p.readFile(path) as Uint8Array);
          const after = await p.lstat(path);
          if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || (this.workspaceFs !== this.zfs && after.ctimeMs !== stat.ctimeMs)) {
            throw new Error(`Workspace changed during checkpoint: ${path}`);
          }
          out.set(path, { type: 'file', size: bytes.length, mode, contentDigest: await sha256(bytes), bytes });
        } else {
          throw new Error(`Unsupported workspace entry (socket, FIFO or device): ${path}`);
        }
      }
    };
    for (const root of this.roots) await visit(root);
    return out;
  }

  private validatePath(path: string, honorExcludes = true): void {
    if (!path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').slice(1).some(p => !p || p === '.' || p === '..')) {
      throw new Error(`Invalid Artipod snapshot path: ${JSON.stringify(path)}`);
    }
    if (!this.roots.some(r => r === '/' || path.startsWith(`${r}/`)) || reservedPath(path) || (honorExcludes && this.excluded(path))) {
      throw new Error(`Artipod snapshot path is outside captured roots: ${path}`);
    }
  }

  // --- persistence ------------------------------------------------------------

  private validateId(id: string): void {
    if (!/^snap-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid Artipod checkpoint ID');
  }

  private manifestPath(id: string): string {
    this.validateId(id);
    return `${SNAP_DIR}/${id}.json`;
  }

  private indexPath(id: string): string {
    this.validateId(id);
    return `${SNAP_DIR}/${id}.index.json`;
  }

  private async readHead(): Promise<string | null> {
    try {
      const id = ((await this.p.readFile(`${SNAP_DIR}/HEAD`, 'utf8')) as string).trim();
      this.validateId(id);
      return id;
    } catch (error) {
      if (!missing(error)) throw error;
      return null;
    }
  }

  private async writeHead(id: string): Promise<void> {
    await this.p.writeFile(`${SNAP_DIR}/HEAD`, id);
  }

  async get(id: string): Promise<SnapshotManifest> {
    const manifest = JSON.parse(await this.p.readFile(this.manifestPath(id), 'utf8') as string) as SnapshotManifest;
    if (!manifest || manifest.formatVersion !== 1 || manifest.mediaType !== SNAPSHOT_MEDIA_TYPE || manifest.id !== id ||
        !Array.isArray(manifest.roots) || !manifest.roots.every(root => typeof root === 'string') ||
        (manifest.parent !== null && (typeof manifest.parent !== 'string' || !/^snap-[a-f0-9]{12}$/.test(manifest.parent))) ||
        typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) ||
        !['manual', 'agent-turn', 'compact'].includes(manifest.origin) || !manifest.diff ||
        typeof manifest.diff.diffId !== 'string' || !isDigest(manifest.diff.diffId) ||
        !Number.isSafeInteger(manifest.diff.size) || manifest.diff.size < 0 ||
        !Number.isSafeInteger(manifest.diff.entryCount) || manifest.diff.entryCount < 0) {
      throw new Error(`Invalid Artipod snapshot manifest: ${id}`);
    }
    return manifest;
  }

  private async cumulativeIndex(id: string): Promise<CumulativeIndex> {
    return JSON.parse((await this.p.readFile(this.indexPath(id), 'utf8')) as string) as CumulativeIndex;
  }

  async list(): Promise<SnapshotManifest[]> {
    let names: string[];
    try {
      names = (await this.p.readdir(SNAP_DIR)) as string[];
    } catch (error) {
      if (!missing(error)) throw error;
      return [];
    }
    const out: SnapshotManifest[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.index.json')) continue;
      out.push(await this.get(name.slice(0, -'.json'.length)));
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
    const rootModes = Object.fromEntries(await Promise.all(this.roots.map(async root => [root, (await this.workspaceFs.promises.lstat(root)).mode & 0o777])));

    const tarEntries: TarWriteEntry[] = [];
    const cumulative: CumulativeIndex = { formatVersion: 1, files: {} };
    const parentRootModes = parentId ? (await this.get(parentId)).rootModes : undefined;
    let changes = parentRootModes && JSON.stringify(rootModes) !== JSON.stringify(parentRootModes) ? 1 : 0;

    for (const [path, record] of current) {
      const prev = parent.files[path];
      const changed =
        !prev ||
        prev.type !== record.type ||
        prev.mode !== record.mode ||
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
      rootModes,
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
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor)) throw new Error('Invalid Artipod snapshot parent cycle');
      seen.add(cursor);
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
    const fromRootModes = (await this.get(fromId)).rootModes;
    let to: Record<string, FileRecord>;
    let toRootModes: Record<string, number> | undefined;
    if (toId) {
      to = (await this.cumulativeIndex(toId)).files;
      toRootModes = (await this.get(toId)).rootModes;
    } else {
      to = {};
      for (const [path, record] of await this.walk()) {
        to[path] = { type: record.type, size: record.size, mode: record.mode, contentDigest: record.contentDigest, linkTarget: record.linkTarget };
      }
      toRootModes = Object.fromEntries(await Promise.all(this.roots.map(async root => [root, (await this.workspaceFs.promises.lstat(root)).mode & 0o777])));
    }
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [path, record] of Object.entries(to)) {
      const prev = from[path];
      if (!prev) added.push(path);
      else if (prev.type !== record.type || prev.mode !== record.mode || prev.contentDigest !== record.contentDigest || prev.linkTarget !== record.linkTarget) modified.push(path);
    }
    for (const path of Object.keys(from)) {
      if (!(path in to)) deleted.push(path);
    }
    // Older snapshots do not record root modes; an unknown mode is not a change.
    for (const [root, mode] of Object.entries(fromRootModes ?? {})) {
      if (toRootModes?.[root] !== undefined && mode !== toRootModes[root] && !modified.includes(root)) modified.push(root);
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
    const destination = at ?? `/branches/${id}`;
    if (!destination.startsWith('/') || destination.includes('\\') || destination.includes('\0') || destination.split('/').slice(1).some(p => !p || p === '.' || p === '..')) {
      throw new Error('Snapshot checkout requires an absolute, non-root destination');
    }
    if (reservedPath(destination)) {
      throw new Error('Snapshot checkout destination must be outside reserved Artipod metadata and runtime paths');
    }
    // Validate every byte/path before even creating the destination directory.
    const { head, target } = await this.validatedSnapshot(id, false, destination);
    const p = this.workspaceFs.promises;
    let ancestor = '';
    for (const part of destination.split('/').slice(1)) {
      ancestor += `/${part}`;
      try {
        const stat = await p.lstat(ancestor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Snapshot checkout destination and its parents must be real directories');
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
    }
    try {
      if ((await p.readdir(destination)).length) throw new Error('Snapshot checkout destination must be empty');
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error;
    }
    await this.ensureDirectory(destination);
    await p.chmod(destination, ((await p.lstat(destination)).mode & 0o777) | 0o700);
    const entries = [...target].sort(([a], [b]) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    for (const [path, entry] of entries) {
      const dest = `${destination}${path}`;
      if (entry.type === 'dir') await this.ensureDirectory(dest);
      else {
        await this.ensureDirectory(dest.slice(0, dest.lastIndexOf('/')) || '/');
        if (entry.type === 'symlink') await p.symlink(entry.linkTarget!, dest);
        else {
          await p.writeFile(dest, entry.bytes!, { flag: 'wx' });
          await p.chmod(dest, entry.mode);
        }
      }
    }
    const directoryModes = new Map(entries.filter(([, entry]) => entry.type === 'dir').map(([path, entry]) => [path, entry.mode]));
    for (const [root, mode] of Object.entries(head.rootModes ?? {})) {
      await this.ensureDirectory(root === '/' ? destination : `${destination}${root}`);
      directoryModes.set(root, mode);
    }
    // Finalize all directory modes together, deepest first: a captured root
    // may be nested beneath another root or an ordinary restrictive directory.
    for (const [directory, mode] of [...directoryModes].sort(([a], [b]) => b.split('/').length - a.split('/').length || b.localeCompare(a))) {
      await p.chmod(directory === '/' ? destination : `${destination}${directory}`, mode);
    }
    return destination;
  }

  /** Shared preflight for in-place restore and a fresh checkout destination. */
  private async validatedSnapshot(id: string, honorExcludes = true, destination = '/'): Promise<{ head: SnapshotManifest; target: Map<string, FileRecord & { bytes?: Uint8Array }> }> {
    const chain = await this.chain(id);
    const head = chain[chain.length - 1];
    if (JSON.stringify(head.roots) !== JSON.stringify(this.roots)) throw new Error('Artipod snapshot roots do not match this workspace');
    const layerBytes = await Promise.all(chain.map(s => this.store.getUncompressed(s.diff.diffId)));
    // Derive indexes from verified tar bytes, not an independently mutable cache.
    const layers = layerBytes.map(bytes => indexTar(bytes));
    for (const layer of layers) for (const entry of layer) this.validatePath(entry.path, honorExcludes);
    const merged = mergeLayerEntries(layers).entries;
    const target = new Map<string, FileRecord & { bytes?: Uint8Array }>();
    for (const [path, entry] of merged) {
      this.validatePath(path, honorExcludes);
      if (!['file', 'dir', 'symlink'].includes(entry.type) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777) {
        throw new Error(`Unsupported Artipod snapshot entry: ${path}`);
      }
      const bytes = entry.type === 'file' ? layerBytes[entry.layer].subarray(entry.offset, entry.offset + entry.size) : undefined;
      if (bytes && bytes.length !== entry.size) throw new Error(`Truncated Artipod snapshot entry: ${path}`);
      target.set(path, { type: entry.type as FileRecord['type'], size: entry.size, mode: entry.mode & 0o777, linkTarget: entry.linkTarget, bytes, contentDigest: bytes ? await sha256(bytes) : undefined });
    }
    // Captured roots can be omitted from the tar, but they and their ancestors
    // must still be directories. Overlapping roots cannot hide an explicit
    // symlink/file at a root boundary from the parent topology validation.
    const implicitDirectories = new Set(['/']);
    for (const root of this.roots) {
      let directory = root;
      while (directory !== '/') {
        implicitDirectories.add(directory);
        directory = directory.slice(0, directory.lastIndexOf('/')) || '/';
      }
    }
    for (const [path, entry] of target) {
      if (implicitDirectories.has(path) && entry.type !== 'dir') throw new Error(`Invalid Artipod snapshot root directory: ${path}`);
      let parent = path.slice(0, path.lastIndexOf('/')) || '/';
      while (parent !== '/') {
        const ancestor = target.get(parent);
        if (ancestor ? ancestor.type !== 'dir' : !implicitDirectories.has(parent)) throw new Error(`Invalid Artipod snapshot parent: ${parent}`);
        parent = parent.slice(0, parent.lastIndexOf('/')) || '/';
      }
      if (entry.type === 'symlink' && !validSymlinkTarget(entry.linkTarget)) throw new Error(`Invalid Artipod snapshot symlink: ${path}`);
    }
    const index = await this.cumulativeIndex(id);
    if (index.formatVersion !== 1 || !index.files || Object.keys(index.files).length !== target.size) throw new Error('Invalid Artipod snapshot cumulative index');
    for (const [path, record] of target) {
      const expected = index.files[path];
      if (!expected || expected.type !== record.type || expected.mode !== record.mode || expected.size !== record.size || expected.contentDigest !== record.contentDigest || expected.linkTarget !== record.linkTarget) {
        throw new Error(`Invalid Artipod snapshot cumulative index at ${path}`);
      }
    }
    for (const [root, mode] of Object.entries(head.rootModes ?? {})) {
      if (!this.roots.includes(root) || !Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error('Invalid Artipod snapshot root mode');
    }
    await this.workspaceFs.validateSnapshotPaths?.([...new Set([...implicitDirectories, ...target.keys()])], { destination });
    return { head, target };
  }

  /**
   * Restore the captured roots in place. All OCI bytes and target topology are
   * checked before the first live mutation; callers must quiesce writers.
   * The root directory is retained so native watchers remain attached.
   * Callers holding locks beneath a root may defer final modes until after
   * releasing those locks. The returned rootModes includes captured roots and
   * ordinary ancestors of those roots, ordered deepest first; deferred callers
   * must apply every returned mode in that order.
   */
  async restore(id: string, options: { deferRootModes?: boolean } = {}): Promise<{ changes: SnapshotRestoreChange[]; rootModes: Record<string, number> }> {
    const { head, target } = await this.validatedSnapshot(id);
    const p = this.workspaceFs.promises;
    // A valid saved tree may repair a native empty-target link in live work;
    // these entries can be unlinked safely but must never enter new snapshots.
    const retainedAncestors = new Set<string>();
    const current = await this.walk(this.workspaceFs, { allowEmptySymlinkTargets: true, retainedAncestors });
    // Live directories may introduce mount boundaries absent from the saved
    // tree. Finish their native preflight before chmod, unlink, or rmdir.
    await this.workspaceFs.validateSnapshotPaths?.([...this.roots, ...current.keys()]);
    let retainedDirectories = false;
    for (const path of retainedAncestors) {
      const next = target.get(path);
      if (next && next.type !== 'dir') throw new Error(`Snapshot target conflicts with an excluded entry's retained ancestor: ${path}`);
      const retained = current.get(path);
      // Extend only the transient restore plan. Stored manifests and indexes
      // still describe the captured tree; exclusions retain their own folders.
      if (!next && retained?.type === 'dir') { target.set(path, retained); retainedDirectories = true; }
    }
    // A retained folder may alias a differently spelled target on native
    // volumes. Validate the extended plan before any live mutation as well.
    if (retainedDirectories) await this.workspaceFs.validateSnapshotPaths?.([...this.roots, ...target.keys()]);
    const changes: SnapshotRestoreChange[] = [];
    const kind = (r: FileRecord): SnapshotRestoreChange['kind'] => r.type === 'dir' ? 'directory' : r.type;
    const same = (a: FileRecord, b: FileRecord) => a.type === b.type && a.mode === b.mode && a.contentDigest === b.contentDigest && a.linkTarget === b.linkTarget;
    for (const [path, old] of current) {
      const next = target.get(path);
      if (!next || next.type !== old.type) changes.push({ path, type: 'deleted', kind: kind(old) });
    }
    for (const [path, next] of target) {
      const old = current.get(path);
      if (!old || old.type !== next.type) changes.push({ path, type: 'created', kind: kind(next) });
      else if (!same(old, next)) changes.push({ path, type: 'changed', kind: kind(next) });
    }
    const rootModes = new Map<string, number>();
    for (const root of this.roots) {
      const mode = (await p.lstat(root)).mode & 0o777;
      rootModes.set(root, head.rootModes?.[root] ?? mode);
      if (mode !== rootModes.get(root)) changes.push({ path: root, type: 'changed', kind: 'directory' });
      if ((mode & 0o700) !== 0o700) await p.chmod(root, mode | 0o700);
    }
    // Ordinary ancestors must remain traversable until nested captured roots
    // and caller locks are finalized, just like the captured roots themselves.
    for (const [path, record] of target) {
      if (record.type === 'dir' && !rootModes.has(path) && this.roots.some(root => root.startsWith(`${path}/`))) {
        rootModes.set(path, record.mode);
      }
    }
    const byDepth = (a: string, b: string) => a.split('/').length - b.split('/').length || a.localeCompare(b);
    for (const [path, record] of [...current].sort(([a], [b]) => byDepth(a, b))) {
      if (record.type === 'dir' && (record.mode & 0o700) !== 0o700) await p.chmod(path, record.mode | 0o700);
    }
    for (const [path, old] of [...current].sort(([a], [b]) => byDepth(b, a))) {
      const next = target.get(path);
      if (!next || next.type !== old.type || (old.type !== 'dir' && !same(old, next))) {
        if (old.type === 'dir') await p.rmdir(path);
        else await p.unlink(path);
      }
    }
    for (const [path, next] of [...target].sort(([a], [b]) => byDepth(a, b))) {
      const old = current.get(path);
      if (next.type === 'dir') {
        await this.ensureDirectory(path);
      } else if (!old || !same(old, next)) {
        await this.ensureDirectory(path.slice(0, path.lastIndexOf('/')) || '/');
        if (next.type === 'symlink') await p.symlink(next.linkTarget!, path);
        else {
          await p.writeFile(path, next.bytes!, { flag: 'wx' });
          await p.chmod(path, next.mode);
        }
      }
    }
    for (const [path, record] of [...target].sort(([a], [b]) => byDepth(b, a))) {
      // Roots and their ancestors are finalized after HEAD/lock bookkeeping.
      if (record.type === 'dir' && !rootModes.has(path)) await p.chmod(path, record.mode);
    }
    // HEAD can live below a root whose captured mode prevents traversal.
    await this.writeHead(id);
    const finalModes = [...rootModes].sort(([a], [b]) => byDepth(b, a));
    if (!options.deferRootModes) for (const [root, mode] of finalModes) await p.chmod(root, mode);
    return { changes, rootModes: Object.fromEntries(finalModes) };
  }

  /** Copy a verified snapshot chain into another pod's OCI store for a fork. */
  async copyTo(id: string, target: SnapshotManager): Promise<void> {
    for (const snap of await this.chain(id)) {
      const bytes = await this.store.getUncompressed(snap.diff.diffId);
      await target.store.putUncompressed(snap.diff.diffId, bytes);
      await target.store.putLayerIndex(snap.diff.diffId, indexTar(bytes));
      await target.p.writeFile(target.manifestPath(snap.id), JSON.stringify(snap));
      await target.p.writeFile(target.indexPath(snap.id), JSON.stringify(await this.cumulativeIndex(snap.id)));
    }
  }

  // --- commit -----------------------------------------------------------------

  /**
   * Freeze the live workspace into a tagged volume image. `layerGroups`
   * routes matching paths into dedicated layers annotated
   * `org.artipod.hydration: lazy` (Phase 6.6 — the intelligence lives at
   * commit time); every layer publishes its index as a digest-addressed
   * artifact annotated on the descriptor, so index-level pulls can serve
   * the full namespace without moving a single layer blob.
   */
  async commit(
    tag: string,
    options: { layerGroups?: string[] } = {},
  ): Promise<{ manifestDigest: Digest; diffId: Digest; size: number; layers: number }> {
    const current = await this.walk();
    const groups = options.layerGroups ?? [];
    const buckets: TarWriteEntry[][] = [[], ...groups.map(() => [] as TarWriteEntry[])];
    for (const [path, r] of current.entries()) {
      const entry: TarWriteEntry = { path, type: r.type, content: r.bytes, mode: r.mode, linkTarget: r.linkTarget };
      const g = groups.findIndex((glob) => pathGlobMatch(glob, path));
      buckets[g === -1 ? 0 : g + 1].push(entry);
    }

    const layerDescriptors: ImageManifest['layers'] = [];
    const diffIds: Digest[] = [];
    let firstDiffId: Digest | null = null;
    let totalSize = 0;
    for (const [b, entries] of buckets.entries()) {
      if (entries.length === 0 && b > 0) continue; // empty group
      const tar = writeTar(entries);
      const diffId = await sha256(tar);
      const compressed = await gzip(tar);
      const layerDigest = await sha256(compressed);
      await this.store.putBlob(compressed, layerDigest);
      await this.store.putUncompressed(diffId, tar);
      const indexEntries = indexTar(tar);
      await this.store.putLayerIndex(diffId, indexEntries);
      // Publish the index beside the manifest (digest-addressed artifact).
      const indexBytes = new TextEncoder().encode(JSON.stringify(makeLayerIndexArtifact(indexEntries)));
      const indexDigest = await sha256(indexBytes);
      await this.store.putBlob(indexBytes, indexDigest);
      layerDescriptors.push({
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        digest: layerDigest,
        size: compressed.length,
        annotations: {
          [ANNOTATION_LAYER_INDEX]: indexDigest,
          ...(b > 0 ? { [ANNOTATION_HYDRATION]: 'lazy', [ANNOTATION_LAYER_GROUP]: groups[b - 1] } : {}),
        },
      });
      diffIds.push(diffId);
      firstDiffId ??= diffId;
      totalSize += compressed.length;
    }

    const config = new TextEncoder().encode(
      JSON.stringify({ artipod: { formatVersion: 1, roots: this.roots }, rootfs: { type: 'layers', diff_ids: diffIds } }),
    );
    const configDigest = await sha256(config);
    await this.store.putBlob(config, configDigest);

    const manifest: ImageManifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: VOLUME_CONFIG_MEDIA_TYPE, digest: configDigest, size: config.length },
      layers: layerDescriptors,
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestDigest = await sha256(manifestBytes);
    await this.store.putBlob(manifestBytes, manifestDigest);
    await this.store.putRef(tag, manifestDigest, manifest.mediaType!);
    return { manifestDigest, diffId: firstDiffId!, size: totalSize, layers: layerDescriptors.length };
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
      rootModes: head.rootModes,
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
    const markDigest = (value: unknown): Digest => {
      if (typeof value !== 'string' || !isDigest(value)) throw new Error('Cannot collect storage with an invalid reachable digest');
      reachableHex.add(value.slice(7));
      return value;
    };
    const snapshots = await this.list();
    const head = await this.readHead();
    if (head && !snapshots.some(snapshot => snapshot.id === head)) throw new Error('Cannot collect storage with a missing snapshot HEAD');
    // Every saved branch contributes roots, including branches outside HEAD.
    // A missing manifest may be recoverable while its layer bytes still exist;
    // never discard those bytes because an incomplete graph hid their digest.
    const snapshotById = new Map(snapshots.map(snapshot => [snapshot.id, snapshot]));
    const validatedSnapshots = new Set<string>();
    for (const snapshot of snapshots) {
      const chain = new Set<string>();
      let cursor: string | null = snapshot.id;
      while (cursor && !validatedSnapshots.has(cursor)) {
        if (chain.has(cursor)) throw new Error('Cannot collect storage with a snapshot parent cycle');
        chain.add(cursor);
        const parent = snapshotById.get(cursor);
        if (!parent) throw new Error('Cannot collect storage when a snapshot parent is missing');
        cursor = parent.parent;
      }
      for (const id of chain) validatedSnapshots.add(id);
    }
    for (const snap of snapshots) markDigest(snap.diff.diffId);

    // Finish the entire reachability graph before issuing any deletion. An
    // unreadable manifest, config, parent or audit record makes sweeping unsafe.
    const decoder = new TextDecoder();
    const imageQueue: Digest[] = [];
    for (const ref of await this.store.listRefs()) {
      const digest = markDigest(ref.manifestDigest);
      if (ref.mediaType === AUDIT_MEDIA_TYPE) {
        const seen = new Set<string>();
        let cursor: Digest | null = digest;
        while (cursor) {
          if (seen.has(cursor)) throw new Error('Cannot collect storage with an audit parent cycle');
          seen.add(cursor);
          const record = JSON.parse(decoder.decode(await this.store.getBlob(cursor))) as { prev?: unknown; event?: unknown } | null;
          if (!record || typeof record !== 'object' || !record.event || (record.prev !== null && typeof record.prev !== 'string')) {
            throw new Error('Cannot collect storage with an invalid audit record');
          }
          cursor = record.prev === null ? null : markDigest(record.prev);
        }
      } else imageQueue.push(digest);
    }
    const images = new Set<string>();
    while (imageQueue.length) {
      const digest = imageQueue.pop()!;
      if (images.has(digest)) continue;
      images.add(digest);
      markDigest(digest);
      const manifest = JSON.parse(decoder.decode(await this.store.getBlob(digest))) as ImageManifest | null;
      if (!manifest || manifest.schemaVersion !== 2 || !manifest.config || !Array.isArray(manifest.layers)) {
        throw new Error('Cannot collect storage with an invalid or unsupported image manifest');
      }
      const configDigest = markDigest(manifest.config.digest);
      for (const layer of manifest.layers) {
        if (!layer || typeof layer !== 'object') throw new Error('Cannot collect storage with an invalid layer descriptor');
        markDigest(layer.digest);
        const index = layer.annotations?.[ANNOTATION_LAYER_INDEX];
        if (index !== undefined) markDigest(index);
      }
      const config = JSON.parse(decoder.decode(await this.store.getBlob(configDigest))) as { rootfs?: { diff_ids?: unknown[] } } | null;
      if (!config || !config.rootfs || !Array.isArray(config.rootfs.diff_ids)) throw new Error('Cannot collect storage with an invalid image config');
      for (const diffId of config.rootfs.diff_ids) markDigest(diffId);
      const parents = manifest.annotations?.[ANNOTATION_PARENTS];
      if (parents !== undefined) {
        const values: unknown = JSON.parse(parents);
        if (!Array.isArray(values)) throw new Error('Cannot collect storage with invalid image parents');
        for (const parent of values) imageQueue.push(markDigest(parent));
      }
    }
    // Blob refs are plaintext-addressed even when aliases point at ciphertext.
    for (const hex of [...reachableHex]) {
      const alias = await this.store.resolveAlias(`sha256:${hex}`);
      if (alias !== null) markDigest(alias);
    }

    const candidates: Array<{ path: string; size: number }> = [];
    for (const dir of ['blobs/sha256', 'uncompressed/sha256', 'indexes/sha256']) {
      let names: string[];
      try { names = (await this.p.readdir(`${OCI_ROOT}/${dir}`)) as string[]; }
      catch (error) { if (missing(error)) continue; throw error; }
      for (const name of names) {
        const hex = name.replace(/\.(json|alias)$/, '');
        if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error('Cannot collect storage with an unrecognized backing record');
        if (reachableHex.has(hex)) continue;
        const path = `${OCI_ROOT}/${dir}/${name}`;
        try {
          const stat = await this.p.stat(path);
          if (!stat.isFile()) throw new Error('Cannot collect storage with a non-file backing record');
          candidates.push({ path, size: stat.size });
        } catch (error) { if (!missing(error)) throw error; }
      }
    }
    let deleted = 0;
    let reclaimedBytes = 0;
    for (const candidate of candidates) {
      await this.p.rm(candidate.path, { force: true });
      deleted += 1;
      reclaimedBytes += candidate.size;
    }
    return { deleted, reclaimedBytes };
  }
}
