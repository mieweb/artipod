/**
 * TreeSource — the headless file-tree data source extracted from
 * artipod-sync's FileTree.tsx (plan §3): getItem/children lookups plus
 * `fs:changed`-driven invalidation, structurally matching react-complex-tree's
 * TreeDataProvider (incl. its change-listener slot) without importing its
 * types. Roots are app-declared (the pod's mount table in Phase 3+), not a
 * hardcoded /repo.
 */
import type { ZenFsLike } from '../sandbox/types.js';
import type { PodEvents } from '../events.js';

export interface TreeItemData {
  index: string;
  isFolder: boolean;
  children: string[];
  /** Display label (basename). */
  data: string;
}

export const TREE_ROOT_ID = 'root';

export interface TreeSourceOptions {
  zfs: ZenFsLike;
  /** Absolute paths shown at the top level. Default: ['/repo']. */
  roots?: string[];
  events?: PodEvents;
}

export class TreeSource {
  private readonly roots: string[];
  private listeners = new Set<(changedIds: string[]) => void>();
  /** Every id handed out — the bounded invalidation set for coarse changes. */
  private knownIds = new Set<string>();
  private disposers: Array<() => void> = [];

  constructor(private readonly opts: TreeSourceOptions) {
    this.roots = opts.roots ?? ['/repo'];
    if (opts.events) {
      this.disposers.push(
        opts.events.on('fs:changed', () => this.invalidate()),
      );
    }
  }

  /** Matches TreeDataProvider.getTreeItem structurally. */
  async getItem(itemId: string): Promise<TreeItemData> {
    if (itemId === TREE_ROOT_ID) {
      this.knownIds.add(TREE_ROOT_ID);
      return { index: TREE_ROOT_ID, isFolder: true, children: [...this.roots], data: 'Root' };
    }
    const path = itemId;
    this.knownIds.add(path);
    try {
      const stat = await this.opts.zfs.promises.stat(path);
      const isFolder = stat.isDirectory();
      let children: string[] = [];
      if (isFolder) {
        const names = (await this.opts.zfs.promises.readdir(path)) as string[];
        children = names.map((f) => (path === '/' ? `/${f}` : `${path}/${f}`)).sort();
      }
      return { index: itemId, isFolder, children, data: path.split('/').pop() || path };
    } catch {
      return { index: itemId, isFolder: false, children: [], data: path.split('/').pop() || path };
    }
  }

  async getChildren(itemId: string): Promise<string[]> {
    return (await this.getItem(itemId)).children;
  }

  /** Matches TreeDataProvider's change-listener slot. */
  onDidChange(listener: (changedIds: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Coarse invalidation: every id the UI has asked about gets re-fetched. */
  invalidate(): void {
    if (this.listeners.size === 0) return;
    const ids = [TREE_ROOT_ID, ...this.knownIds];
    const unique = [...new Set(ids)];
    for (const l of [...this.listeners]) l(unique);
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    this.listeners.clear();
  }
}
