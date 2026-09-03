/**
 * Registry snapshot store: the workspace list rendered by the catalog.
 * Write-through cache over UiStateIO (the fs file stays the cross-tab
 * source of truth); actions refresh the snapshot after every mutation.
 */
import { createStore } from 'zustand/vanilla';
import type { LocalEntry, OpenMode, UiStateIO } from '../services/ui-state';

export interface RegistrySnapshot {
  entries: LocalEntry[];
  actor: string | null;
}

export const registryStore = createStore<RegistrySnapshot>()(() => ({
  entries: [],
  actor: null,
}));

/** Bind the store's actions to an IO instance (the app does this once at boot). */
export function registryActions(io: UiStateIO) {
  const refresh = async (): Promise<LocalEntry[]> => {
    const state = await io.read();
    registryStore.setState({ entries: state.workspaces, actor: state.actor ?? null });
    return state.workspaces;
  };
  return {
    refresh,
    async record(id: string, kind: 'pod' | 'blank', mode: OpenMode): Promise<void> {
      await io.recordWorkspace(id, kind, mode);
      await refresh();
    },
    async patch(id: string, patch: Partial<LocalEntry>): Promise<void> {
      await io.patch(id, patch);
      await refresh();
    },
    async drop(ids: string[]): Promise<void> {
      await io.drop(ids);
      await refresh();
    },
  };
}
