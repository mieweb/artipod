/**
 * Workspace snapshot store (spa-ui-plan U3): everything the workspace shell
 * renders. Live objects (pod, sandbox, events) stay in PodSessionService;
 * this holds serializable state only (P4).
 */
import { createStore } from 'zustand/vanilla';

export type ViewMode = 'tree' | 'editor' | 'settings' | 'agent' | 'layers';

export type SyncBadge =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'synced'; at: number; layers: number }
  | { kind: 'failed'; at: number; error?: string };

export interface WorkspaceSnapshot {
  phase: 'opening' | 'ready' | 'error';
  error?: string;
  root: string;
  backend?: string;
  isPrimaryTab: boolean;
  activeView: ViewMode;
  editingFile: string | null;
  /** rw ref workspaces auto-push; the badge only renders when true. */
  syncActive: boolean;
  sync: SyncBadge;
  publish: { open: boolean; value: string; notice: string | null; publishing: boolean };
}

export const initialWorkspace: WorkspaceSnapshot = {
  phase: 'opening',
  root: '/',
  isPrimaryTab: true,
  activeView: 'tree',
  editingFile: null,
  syncActive: false,
  sync: { kind: 'idle' },
  publish: { open: false, value: '', notice: null, publishing: false },
};

export const workspaceStore = createStore<WorkspaceSnapshot>()(() => ({ ...initialWorkspace }));

export const setView = (view: ViewMode): void => workspaceStore.setState({ activeView: view });
export const setEditingFile = (path: string | null): void =>
  workspaceStore.setState({ editingFile: path, ...(path ? { activeView: 'editor' as const } : {}) });
export const patchPublish = (patch: Partial<WorkspaceSnapshot['publish']>): void =>
  workspaceStore.setState({ publish: { ...workspaceStore.getState().publish, ...patch } });
