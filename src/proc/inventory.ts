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

const kv = (rows: [string, string | undefined][]): string =>
  `${rows.map(([k, v]) => `${k}:\t${v ?? '-'}`).join('\n')}\n`;

/** `/proc/images/<slug>/status` and `/proc/workspaces/<slug>/status`. */
export function makeInventoryProvider(providers: InventoryProviders): ProcProvider {
  return {
    name: 'inventory',
    description: 'Server images and local workspaces (images / volumes)',
    mode: 'ro',
    root: '',
    async read(): Promise<ProcTree> {
      const tree: ProcTree = {};
      for (const image of (await providers.images?.()) ?? []) {
        const detail = await providers.imageDetail?.(image.ref);
        const slug = mountSlug(image.ref);
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
      }
      for (const volume of (await providers.volumes?.()) ?? []) {
        tree[`workspaces/${mountSlug(volume.name)}/status`] = kv([
          ['Name', volume.name], ['Type', volume.type], ['Mode', volume.mode], ['Encryption', volume.encryption],
          ['State', volume.state], ['Mounted', volume.mountpoint ? 'yes' : 'no'], ['Mountpoint', volume.mountpoint || undefined],
        ]);
      }
      return tree;
    },
  };
}
