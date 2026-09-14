/**
 * Inventory: what this machine knows about, whether or not it is running.
 *
 *   images   — refs on the server (docker-speak: things you can instantiate)
 *   volumes  — local workspaces (docker-speak: what instantiation produced;
 *              MOUNTPOINT is set only while a tab has one open)
 *
 * `mount` / `lsblk` / `df` already exist and describe this shell's ZenFS
 * backends and mount points — a different, narrower thing.
 *
 * Data is app-provided (the catalog already computes it); this module only
 * renders it and projects it into /proc so `tree` and the page line up.
 */
import type { ProcProvider, ProcTree } from './registry.js';

export interface ImageRow {
  ref: string;
  digest?: string;
  encryption?: 'e2e' | 'encrypted' | 'plaintext';
  locked?: boolean;
  /** synced / update available / out of sync / local changes / forked … */
  status?: string;
}

export interface LayerRow {
  digest: string;
  size: number;
  /** org.artipod.path — the file (or group glob / whiteout) this layer carries. */
  path?: string;
  /** org.artipod.mtime, epoch ms. */
  mtimeMs?: number;
  actor?: string;
  overlay?: boolean;
  /** Hydration: the blob is in the local store (`●`) or still lazy (`☁︎`). Unknown when undefined. */
  local?: boolean;
}

/** `images -v`: where the bytes are and what the layers hold. */
export interface ImageDetail {
  manifestDigest: string;
  /** Browser-local OCI store path of the manifest blob (e.g. /.artipod/oci/blobs/sha256/…). */
  localPath: string;
  /** Whether that blob exists locally at all. */
  localPresent: boolean;
  /** Encrypted stores keep a plaintext→ciphertext `.alias` twin next to the blob. */
  aliasPath?: string;
  /** Where the server serves it from. */
  remoteUrl?: string;
  layers: LayerRow[];
  /** org.artipod.parents — the previous head(s) this manifest was built on. */
  parents: string[];
  /** Layers present in this manifest but not in its first parent — what this tag changed. */
  changed?: LayerRow[];
  actor?: string;
  /** The manifest exactly as stored (JSON text), for /proc/images/<slug>/manifest.json. */
  manifest?: string;
  /** Set when the manifest could not be read (not pulled, or locked without a key). */
  unavailable?: string;
}

export interface VolumeRow {
  name: string;
  type: 'blank' | 'fork' | 'ref';
  mode?: string;
  encryption?: 'e2e' | 'encrypted' | 'plaintext';
  state?: string;
  /** Set only while a tab has the workspace open. */
  mountpoint?: string;
}

export interface InventoryProviders {
  images?: () => Promise<ImageRow[]> | ImageRow[];
  volumes?: () => Promise<VolumeRow[]> | VolumeRow[];
  /** Optional: detail for one image (`images -v`). */
  imageDetail?: (ref: string) => Promise<ImageDetail | null> | ImageDetail | null;
}

export const shortDigest = (digest?: string): string => (digest ? digest.replace(/^sha256:/, '').slice(0, 8) : '-');
/** Same slug the pod uses for `/open/<slug>` basis mounts. */
export const mountSlug = (ref: string): string => ref.replace(/[^a-zA-Z0-9._-]+/g, '_');

/**
 * `mountSlug` is not injective (`a/b:t` and `a_b:t` both give `a_b_t`); as a
 * `/proc` directory name that would silently overwrite. Later colliders get
 * `~2`, `~3`, … in listing order.
 */
export function uniqueSlugs(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const slug = mountSlug(name);
    const n = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, n);
    return n === 1 ? slug : `${slug}~${n}`;
  });
}

const kv = (rows: [string, string | undefined][]): string =>
  `${rows.map(([k, v]) => `${k}:\t${v ?? '-'}`).join('\n')}\n`;

/**
 * `/proc/images/<slug>/{status,manifest.json}` and `/proc/workspaces/<slug>/status`.
 *
 * `refreshProc()` runs this before every live command, so image detail (which
 * may open a store or fetch a manifest) is cached per `ref@digest` and only
 * re-fetched when the row's digest moves; the misses are loaded in parallel.
 * Consequence: the `Hydrated` count under /proc follows the digest, not every
 * pull — `images -v` reads detail live and is the fresh view.
 */
export function makeInventoryProvider(providers: InventoryProviders): ProcProvider {
  const details = new Map<string, ImageDetail | null>();
  return {
    name: 'inventory',
    description: 'Server images and local workspaces (images / volumes)',
    mode: 'ro',
    root: '',
    async read(): Promise<ProcTree> {
      const tree: ProcTree = {};
      const images = (await providers.images?.()) ?? [];
      const detailOf = async (image: ImageRow): Promise<ImageDetail | null> => {
        if (!providers.imageDetail) return null;
        const key = `${image.ref}@${image.digest ?? ''}`;
        if (!details.has(key)) {
          try {
            details.set(key, await providers.imageDetail(image.ref));
          } catch {
            return null; // transient — try again next refresh
          }
        }
        return details.get(key) ?? null;
      };
      const loaded = await Promise.all(images.map(detailOf));
      const imageSlugs = uniqueSlugs(images.map((i) => i.ref));
      images.forEach((image, i) => {
        const detail = loaded[i];
        const slug = imageSlugs[i];
        tree[`images/${slug}/status`] = kv([
          ['Ref', image.ref], ['Digest', image.digest], ['Encryption', image.encryption],
          ['Locked', image.locked ? 'yes' : 'no'], ['Status', image.status],
          ['Local', detail ? `${detail.localPath}${detail.localPresent ? '' : ' (not pulled)'}` : undefined],
          ['Alias', detail?.aliasPath], ['Remote', detail?.remoteUrl],
          ['Layers', detail && !detail.unavailable ? String(detail.layers.length) : undefined],
          ['Hydrated', detail && !detail.unavailable ? `${detail.layers.filter((l) => l.local).length}/${detail.layers.length}` : undefined],
        ]);
        // The real artifact, for jq. Absent when the manifest is not readable here.
        if (detail?.manifest) tree[`images/${slug}/manifest.json`] = detail.manifest;
      });
      const volumes = (await providers.volumes?.()) ?? [];
      const volumeSlugs = uniqueSlugs(volumes.map((v) => v.name));
      volumes.forEach((volume, i) => {
        tree[`workspaces/${volumeSlugs[i]}/status`] = kv([
          ['Name', volume.name], ['Type', volume.type], ['Mode', volume.mode], ['Encryption', volume.encryption],
          ['State', volume.state], ['Mounted', volume.mountpoint ? 'yes' : 'no'], ['Mountpoint', volume.mountpoint || undefined],
        ]);
      });
      return tree;
    },
  };
}
