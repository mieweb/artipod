/**
 * OciLayerFS / OciViewFS (issue #1 steps 3–4): read-only ZenFS filesystems
 * over indexed layers. A single flattened view applies OCI whiteout
 * semantics (`.wh.<name>`, `.wh..wh..opq`) at merge time — `--through N`
 * truncates history by merging only the first N layers. Mounting a single
 * layer is the one-layer special case of the same machinery.
 *
 * Reads slice the uncompressed content-addressed twins held in memory per
 * mounted layer — whole-layer hydration by design (plan Decision #12).
 */

import { ErrnoError, Index, IndexFS, constants, mount as zenMount, umount as zenUmount } from '@zenfs/core';
import type { ZenFsLike } from '../sandbox/types.js';
import { whiteoutTarget, type LayerEntry } from './tar.js';

interface ResolvedContent {
  /** Index into the layers array handed to the view. */
  layer: number;
  offset: number;
  size: number;
}

export interface MergedView {
  /** path → winning entry (whiteouts applied, hardlinks unresolved). */
  entries: Map<string, LayerEntry & ResolvedContent>;
}

const dirOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
};

/**
 * Merge ordered layer indexes bottom → top with whiteout semantics.
 * Pure data — the substrate for OciViewFS and for Phase 6.6's placeholders.
 */
export function mergeLayerEntries(layers: LayerEntry[][]): MergedView {
  const entries = new Map<string, LayerEntry & ResolvedContent>();

  const removeSubtree = (root: string) => {
    entries.delete(root);
    const prefix = root === '/' ? '/' : `${root}/`;
    for (const path of [...entries.keys()]) {
      if (path.startsWith(prefix)) entries.delete(path);
    }
  };

  layers.forEach((layer, layerIdx) => {
    for (const entry of layer) {
      const wh = whiteoutTarget(entry.path);
      if (wh) {
        if (wh.kind === 'opaque') {
          const prefix = wh.dir === '/' ? '/' : `${wh.dir}/`;
          for (const path of [...entries.keys()]) {
            if (path.startsWith(prefix)) entries.delete(path);
          }
        } else {
          removeSubtree(wh.target);
        }
        continue;
      }
      if (entry.type !== 'dir') {
        // replacing a dir with a file (or vice versa) drops what was underneath
        const existing = entries.get(entry.path);
        if (existing?.type === 'dir') removeSubtree(entry.path);
      }
      entries.set(entry.path, { ...entry, layer: layerIdx, offset: entry.offset, size: entry.size });
    }
  });

  return { entries };
}

const S_MASK = 0o7777;

type ErrnoCode = ConstructorParameters<typeof ErrnoError>[0];
const errno = (code: string, message: string) => new ErrnoError(code as unknown as ErrnoCode, message);

/** Read of a dehydrated placeholder — fail fast, never fetch (no grep bombs).
 * A real ErrnoError (EREMOTE) so zenfs propagates it instead of wrapping
 * foreign errors as ENOENT. */
export class DehydratedError extends ErrnoError {
  constructor(path: string) {
    super(
      // kerium Errno.EREMOTE — zenfs doesn't re-export the enum.
      66 as unknown as ErrnoCode,
      `${path}: content is dehydrated — run \`artipod hydrate ${path}\` (or click to hydrate)`,
    );
    this.name = 'DehydratedError';
  }
}

/** Read-only IndexFS over merged layer entries + their uncompressed blobs. */
export class OciViewFS extends IndexFS {
  private content: Map<string, ResolvedContent & { linkTarget?: string; type: LayerEntry['type'] }>;

  constructor(
    name: string,
    view: MergedView,
    /** null = dehydrated placeholder layer (metadata only, reads fail fast). */
    private readonly layerBytes: (Uint8Array | null)[],
  ) {
    const content = new Map<string, ResolvedContent & { linkTarget?: string; type: LayerEntry['type'] }>();
    const index = new Index();
    const entries: Record<string, { mode: number; size: number; mtimeMs?: number }> = {
      '/': { mode: constants.S_IFDIR | 0o755, size: 0 },
    };

    // Parent dirs may be implicit in tars — synthesize them.
    const ensureDir = (dir: string) => {
      if (dir === '/' || entries[dir]) return;
      ensureDir(dirOf(dir));
      entries[dir] ??= { mode: constants.S_IFDIR | 0o755, size: 0 };
    };

    // Hardlink targets resolve to their content; missing targets read empty.
    const resolveHardlink = (entry: LayerEntry & ResolvedContent): ResolvedContent => {
      const target = entry.linkTarget ? view.entries.get(entry.linkTarget) : undefined;
      return target && target.type === 'file'
        ? { layer: target.layer, offset: target.offset, size: target.size }
        : { layer: entry.layer, offset: entry.offset, size: 0 };
    };

    for (const [path, entry] of view.entries) {
      ensureDir(dirOf(path));
      if (entry.type === 'dir') {
        entries[path] = { mode: constants.S_IFDIR | (entry.mode & S_MASK || 0o755), size: 0, mtimeMs: entry.mtimeMs };
      } else if (entry.type === 'symlink') {
        const target = entry.linkTarget ?? '';
        entries[path] = { mode: constants.S_IFLNK | 0o777, size: target.length, mtimeMs: entry.mtimeMs };
        content.set(path, { layer: -1, offset: 0, size: target.length, linkTarget: target, type: 'symlink' });
      } else {
        const resolved = entry.type === 'hardlink' ? resolveHardlink(entry) : entry;
        entries[path] = {
          mode: constants.S_IFREG | (entry.mode & S_MASK || 0o644),
          size: resolved.size,
          mtimeMs: entry.mtimeMs,
        };
        content.set(path, { layer: resolved.layer, offset: resolved.offset, size: resolved.size, type: entry.type });
      }
    }

    index.fromJSON({ version: 1, entries } as never);
    super(0x6f636966 /* 'ocif' */, 'ocifs', index);
    this.content = content;
    this.attributes.set('no_write', undefined);
  }

  private slice(path: string, offset: number, end: number): Uint8Array {
    const c = this.content.get(path);
    if (!c) throw errno('ENOENT', `${path}: no such entry in OCI view`);
    if (c.linkTarget !== undefined) {
      return new TextEncoder().encode(c.linkTarget).subarray(offset, end);
    }
    const bytes = this.layerBytes[c.layer];
    if (bytes === null) throw new DehydratedError(path);
    if (!bytes) throw errno('EIO', `${path}: layer bytes unavailable`);
    const start = c.offset + offset;
    return bytes.subarray(start, Math.min(c.offset + c.size, c.offset + end));
  }

  async read(path: string, buffer: Uint8Array, offset = 0, end: number): Promise<void> {
    this.readSync(path, buffer, offset, end);
  }

  readSync(path: string, buffer: Uint8Array, offset = 0, end: number): void {
    if (end - offset <= 0) return;
    buffer.set(this.slice(path, offset, end));
  }

  async write(path: string): Promise<void> {
    throw errno('EROFS', `${path}: OCI views are read-only`);
  }

  writeSync(path: string): void {
    throw errno('EROFS', `${path}: OCI views are read-only`);
  }

  protected async remove(path: string): Promise<void> {
    throw errno('EROFS', `${path}: OCI views are read-only`);
  }

  protected removeSync(path: string): void {
    throw errno('EROFS', `${path}: OCI views are read-only`);
  }
}

export interface MountViewOptions {
  zfs: ZenFsLike;
  at: string;
  /** Ordered layer indexes, bottom first. */
  layers: LayerEntry[][];
  /** Uncompressed layer bytes, same order; null = dehydrated placeholder. */
  layerBytes: (Uint8Array | null)[];
  /** Merge only the first N layers (issue #1 `--through N`). */
  through?: number;
  name?: string;
}

/** Build + mount a flattened read-only view; returns its unmount function. */
export async function mountOciView(options: MountViewOptions): Promise<() => void> {
  const n = options.through !== undefined ? Math.max(0, Math.min(options.through, options.layers.length)) : options.layers.length;
  const view = mergeLayerEntries(options.layers.slice(0, n));
  const fs = new OciViewFS(options.name ?? 'oci-view', view, options.layerBytes.slice(0, n));
  await options.zfs.promises.mkdir(options.at, { recursive: true });
  zenMount(options.at, fs as never);
  return () => zenUmount(options.at);
}
