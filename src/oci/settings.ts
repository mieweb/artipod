/**
 * Pod settings — small, cleartext, POD-RESIDENT state (`/.artipod/settings.json`),
 * so the same `artipod offline` verb works in every shell over the pod: the
 * browser workspace, the node CLI, anything embedding the command surface.
 * Offline mode gates sync verbs and auto-push; UIs mirror it into their own
 * network layers (the demo blocks /api fetches while it is on).
 */
import type { ZenFsLike } from '../sandbox/types.js';
import { OCI_ROOT } from './store.js';

export const SETTINGS_PATH = `${OCI_ROOT}/settings.json`;

export interface PodSettings {
  /** Sync verbs and auto-push refuse to touch the network while true. */
  offline?: boolean;
}

export async function readPodSettings(zfs: ZenFsLike): Promise<PodSettings> {
  try {
    return JSON.parse((await zfs.promises.readFile(SETTINGS_PATH, 'utf8')) as string) as PodSettings;
  } catch {
    return {};
  }
}

export async function writePodSettings(zfs: ZenFsLike, patch: Partial<PodSettings>): Promise<PodSettings> {
  const next = { ...(await readPodSettings(zfs)), ...patch };
  await zfs.promises.mkdir(OCI_ROOT, { recursive: true }).catch(() => {});
  await zfs.promises.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}
