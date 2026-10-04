/**
 * Settings snapshot store (spa-ui-plan P6): forced-offline's source of truth
 * is the POD SETTING (/.artipod/oci/settings.json — what `artipod offline`
 * writes); the mirror is only the synchronous boot copy. KeysService owns
 * the write path; this store is the render surface.
 */
import { createStore } from 'zustand/vanilla';

export interface SettingsSnapshot {
  forcedOffline: boolean;
}

export const settingsStore = createStore<SettingsSnapshot>()(() => ({
  forcedOffline: false,
}));
