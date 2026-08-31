'use client';

/**
 * Thin react-complex-tree shell over @artipod/core/host's TreeSource
 * (plan Phase 2): the tree auto-refreshes after every command via
 * fs:changed-driven invalidation; the Refresh button remains as a manual
 * escape hatch.
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  UncontrolledTreeEnvironment,
  Tree,
  TreeDataProvider,
  TreeItem,
  TreeItemIndex,
} from 'react-complex-tree';
import 'react-complex-tree/lib/style-modern.css';
import { TreeSource, TREE_ROOT_ID } from '@artipod/core/host';
import type { PodEvents } from '@artipod/core/host';
import { fs } from '@/lib/filesystem';

interface FileTreeProps {
  onSelectFile: (path: string) => void;
  events?: PodEvents;
  /** Tree roots. Default: /repo (a basis workspace passes its overlay path). */
  roots?: string[];
  /** Absolute paths still remote (sync plan D) — rendered with a cloud badge. */
  getDehydratedPaths?: () => Promise<string[]>;
}

export default function FileTree({ onSelectFile, events, roots, getDehydratedPaths }: FileTreeProps) {
  const sourceRef = useRef<TreeSource | null>(null);
  const dehydratedRef = useRef<Set<string>>(new Set());
  const rootsKey = (roots ?? ['/repo']).join(',');

  const dataProvider = useMemo<TreeDataProvider>(() => {
    sourceRef.current?.dispose();
    // Bus subscription lives in the effect below, not the constructor:
    // StrictMode replays effect cleanup, which would strand a memoized
    // instance whose constructor-time subscription was disposed.
    const source = new TreeSource({ zfs: fs, roots: rootsKey.split(',') });
    sourceRef.current = source;
    return {
      getTreeItem: async (itemId: TreeItemIndex): Promise<TreeItem> =>
        (await source.getItem(String(itemId))) as TreeItem,
      onDidChangeTreeData: (listener) => {
        const off = source.onDidChange((ids) => listener(ids));
        return { dispose: off };
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey]);

  useEffect(() => {
    if (!getDehydratedPaths) return;
    let cancelled = false;
    const refresh = () =>
      getDehydratedPaths()
        .then((paths) => {
          if (cancelled) return;
          dehydratedRef.current = new Set(paths);
          sourceRef.current?.invalidate();
        })
        .catch(() => {});
    refresh();
    const offs = [events?.on('fetch:done', refresh), events?.on('fs:changed', refresh)];
    return () => {
      cancelled = true;
      for (const off of offs) off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, rootsKey]);

  useEffect(() => {
    if (!events) return;
    return events.on('fs:changed', () => sourceRef.current?.invalidate());
  }, [events]);

  useEffect(() => () => sourceRef.current?.dispose(), []);

  return (
    // rct-dark: react-complex-tree's dark theme vars (arrow/focus/hover colors)
    <div className="rct-dark h-full w-full bg-[#1e1e1e] text-white p-2 overflow-auto">
      <div className="flex justify-between items-center mb-2">
        <h3 className="font-bold">File Explorer</h3>
        <button
          onClick={() => sourceRef.current?.invalidate()}
          className="text-xs bg-gray-700 px-2 py-1 rounded hover:bg-gray-600"
        >
          Refresh
        </button>
      </div>
      <UncontrolledTreeEnvironment
        dataProvider={dataProvider}
        getItemTitle={(item) =>
          `${item.data as string}${dehydratedRef.current.has(String(item.index)) ? ' ☁︎' : ''}`
        }
        viewState={{
          'tree-1': {
            expandedItems: rootsKey.split(','),
          },
        }}
        onPrimaryAction={(item) => {
          if (!item.isFolder) {
            onSelectFile(item.index as string);
          }
        }}
      >
        <Tree treeId="tree-1" rootItem={TREE_ROOT_ID} treeLabel="Project Files" />
      </UncontrolledTreeEnvironment>
    </div>
  );
}
