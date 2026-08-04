'use client';

import { useEffect, useMemo, useState } from 'react';
import { UncontrolledTreeEnvironment, Tree, TreeDataProvider, TreeItem, TreeItemIndex } from 'react-complex-tree';
import 'react-complex-tree/lib/style-modern.css';
import { fs } from '@/lib/filesystem';

interface FileTreeProps {
  onSelectFile: (path: string) => void;
}

export default function FileTree({ onSelectFile }: FileTreeProps) {
  const [refreshKey, setRefreshKey] = useState(0);

  const dataProvider = useMemo<TreeDataProvider>(() => ({
    getTreeItem: async (itemId: TreeItemIndex): Promise<TreeItem> => {
      if (itemId === 'root') {
        return {
          index: 'root',
          isFolder: true,
          children: ['/repo'],
          data: 'Root',
        };
      }

      const path = itemId as string;
      
      try {
        const stat = await fs.promises.stat(path);
        const isFolder = stat.isDirectory();
        let children: TreeItemIndex[] = [];

        if (isFolder) {
          const files = await fs.promises.readdir(path);
          children = files.map((f: string) => {
            const childPath = path === '/' ? `/${f}` : `${path}/${f}`;
            return childPath;
          });
        }

        return {
          index: itemId,
          isFolder,
          children,
          data: path.split('/').pop() || path,
        };
      } catch (e) {
        console.error(`Error loading ${path}`, e);
        return {
          index: itemId,
          isFolder: false,
          children: [],
          data: 'Error',
        };
      }
    },
  }), [refreshKey]);

  return (
    // rct-dark: react-complex-tree's dark theme vars (arrow/focus/hover colors)
    <div className="rct-dark h-full w-full bg-[#1e1e1e] text-white p-2 overflow-auto">
      <div className="flex justify-between items-center mb-2">
        <h3 className="font-bold">File Explorer</h3>
        <button 
          onClick={() => setRefreshKey(k => k + 1)}
          className="text-xs bg-gray-700 px-2 py-1 rounded hover:bg-gray-600"
        >
          Refresh
        </button>
      </div>
      <UncontrolledTreeEnvironment
        dataProvider={dataProvider}
        getItemTitle={(item) => item.data as string}
        viewState={{
          'tree-1': {
            expandedItems: ['/repo'],
          },
        }}
        onPrimaryAction={(item) => {
          if (!item.isFolder) {
            onSelectFile(item.index as string);
          }
        }}
      >
        <Tree treeId="tree-1" rootItem="root" treeLabel="Project Files" />
      </UncontrolledTreeEnvironment>
    </div>
  );
}
