/**
 * Pod settings — small, POD-RESIDENT logical JSON (`/.artipod/oci/settings.json`),
 * so the same `artipod offline` verb works in every shell over the pod: the
 * browser workspace, the node CLI, anything embedding the command surface.
 * Offline mode gates sync verbs and auto-push; UIs mirror it into their own
 * network layers (the demo blocks /api fetches while it is on).
 */
import type { ZenFsLike } from '../sandbox/types.js';
import { OCI_ROOT } from './store.js';
import { readStorageTextFile, writeStorageTextFile } from '../storage/text-file.js';

export const SETTINGS_PATH = `${OCI_ROOT}/settings.json`;
const PREVIOUS_PATH = `${OCI_ROOT}/.settings.previous`;

export interface PodSettings {
  /** Sync verbs and auto-push refuse to touch the network while true. */
  offline?: boolean;
}

export async function readPodSettings(zfs: ZenFsLike): Promise<PodSettings> {
  const text = await readStorageTextFile({ zfs, path: SETTINGS_PATH, previousPath: PREVIOUS_PATH });
  if (text === null) return {};
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ('offline' in value && typeof value.offline !== 'boolean')) {
    throw new Error('Invalid pod settings; saved preferences were preserved');
  }
  return value as PodSettings;
}

export async function writePodSettings(zfs: ZenFsLike, patch: Partial<PodSettings>): Promise<PodSettings> {
  const next = { ...(await readPodSettings(zfs)), ...patch };
  if (next.offline !== undefined && typeof next.offline !== 'boolean') throw new Error('Invalid offline preference');
  await writeStorageTextFile({ zfs, path: SETTINGS_PATH, previousPath: PREVIOUS_PATH }, JSON.stringify(next, null, 2));
  return next;
}
