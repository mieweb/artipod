/**
 * Pod settings — small, POD-RESIDENT logical JSON (`/.artipod/oci/settings.json`),
 * so the same `artipod offline` verb works in every shell over the pod: the
 * browser workspace, the node CLI, anything embedding the command surface.
 * Offline mode gates sync verbs and auto-push; UIs mirror it into their own
 * network layers (the demo blocks /api fetches while it is on).
 */
import type { ZenFsLike } from '../sandbox/types.js';
import { OCI_ROOT } from './store.js';
import { resolveStorageAccess } from '../storage/context.js';

export const SETTINGS_PATH = `${OCI_ROOT}/settings.json`;

export interface PodSettings {
  /** Sync verbs and auto-push refuse to touch the network while true. */
  offline?: boolean;
}

export async function readPodSettings(zfs: ZenFsLike): Promise<PodSettings> {
  try {
    const value: unknown = JSON.parse((await zfs.promises.readFile(SETTINGS_PATH, 'utf8')) as string);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ('offline' in value && typeof value.offline !== 'boolean')) {
      throw new Error('Invalid pod settings; saved preferences were preserved');
    }
    return value as PodSettings;
  } catch (error) {
    if ((error as { code?: string })?.code !== 'ENOENT') throw error;
    return {};
  }
}

export async function writePodSettings(zfs: ZenFsLike, patch: Partial<PodSettings>): Promise<PodSettings> {
  const next = { ...(await readPodSettings(zfs)), ...patch };
  if (next.offline !== undefined && typeof next.offline !== 'boolean') throw new Error('Invalid offline preference');
  const storage = resolveStorageAccess(zfs);
  const temporary = `${OCI_ROOT}/.${crypto.randomUUID().replace(/-/g, '')}`;
  await zfs.promises.mkdir(OCI_ROOT, { recursive: true });
  // Never shrink the live settings inode in place. A failed multi-block
  // transaction can otherwise persist new bytes with the old length. Stage
  // inside the same protected root and drain before replacing its name.
  // A failed stage may leave an opaque temporary; the saved preference stays
  // intact and the pending key-service preference can replay after recovery.
  await zfs.promises.writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx' });
  await storage?.flush();
  await zfs.promises.rename(temporary, SETTINGS_PATH);
  await storage?.flush();
  return next;
}
