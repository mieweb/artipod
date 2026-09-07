/**
 * Inventory: what this machine knows about, whether or not it is running.
 *
 *   images  — refs on the server (docker-speak: things you can instantiate)
 *   lsblk   — local workspaces (block devices: they exist whether mounted;
 *             MOUNTPOINT is set only while a tab has one open)
 *   mount   — lsblk filtered to mounted rows
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
    description: 'Server images and local workspaces (images / lsblk)',
    mode: 'ro',
    root: '',
    async read(): Promise<ProcTree> {
      const tree: ProcTree = {};
      for (const image of (await providers.images?.()) ?? []) {
        tree[`images/${mountSlug(image.ref)}/status`] = kv([
          ['Ref', image.ref], ['Digest', image.digest], ['Encryption', image.encryption],
          ['Locked', image.locked ? 'yes' : 'no'], ['Status', image.status],
        ]);
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
