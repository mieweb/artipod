'use client';

import { useEffect, useState, useRef } from 'react';
import dynamicImport from 'next/dynamic';
import { initFileSystem } from '@/lib/filesystem';
import { PodEvents } from '@artipod/core/host';
import type { Sandbox } from '@/lib/sandbox/types';
import type { InitResult } from '@/lib/sandbox/storage';
import Editor from '@/components/Editor';
import FileTree from '@/components/FileTree';
import StorageSettings from '@/components/StorageSettings';
import AgentPanel from '@/components/AgentPanel';
import { Terminal as LucideTerminal, FolderTree, FileCode, Settings, Bot } from 'lucide-react';

// Dynamically import Terminal to avoid SSR issues with xterm.js
const Terminal = dynamicImport(() => import('@/components/Terminal'), {
  ssr: false,
});

export const dynamic = 'force-dynamic';

type ViewMode = 'terminal' | 'tree' | 'editor' | 'settings' | 'agent';

export default function Home() {
  const [fsReady, setFsReady] = useState(false);
  const [fsInfo, setFsInfo] = useState<InitResult | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ViewMode>('terminal');
  const sandboxRef = useRef<Sandbox | null>(null);
  // One event bus per pod: terminal, tree, editor and agent stay coherent.
  const eventsRef = useRef<PodEvents | null>(null);
  if (!eventsRef.current) eventsRef.current = new PodEvents();
  const events = eventsRef.current;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const info = await initFileSystem();
      // just-bash is loaded lazily so it stays out of the first-load bundle
      const [{ createSandbox }, { fs }] = await Promise.all([
        import('@/lib/sandbox'),
        import('@/lib/filesystem'),
      ]);
      if (cancelled) return;
      setFsInfo(info);
      // PAT prompt for git push/fetch to private repos (token kept off the sandbox fs)
      const { setAuthPrompt } = await import('@/lib/git-auth');
      setAuthPrompt(async (origin) =>
        window.prompt(`Personal access token for ${origin} (stored in memory):`),
      );
      sandboxRef.current = createSandbox({
        zfs: fs,
        events,
        onEdit: (path) => {
          setEditingFile(path);
          setActiveView('editor');
        },
      });
      setFsReady(true);
    })().catch((e) => console.error('Sandbox init failed:', e));
    return () => {
      cancelled = true;
    };
  }, []);

  // iOS Safari: the keyboard shrinks only the *visual* viewport, so mirror its
  // height into --app-height and keep the page pinned to the top.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      if (vv.scale !== 1) return; // ignore pinch-zoom
      document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
      window.scrollTo(0, 0); // undo Safari's focus-driven page push
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, []);

  const handleFileSelect = (path: string) => {
    setEditingFile(path);
    setActiveView('editor');
  };

  const handleCloseEditor = () => {
    setEditingFile(null);
    setActiveView('terminal');
  };

  return (
    <main className="flex h-[var(--app-height)] flex-col bg-black text-white overflow-hidden pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {/* Navigation Bar */}
      <div className="flex items-center bg-[#2d2d2d] border-b border-gray-700 px-2">
        <button
          onClick={() => setActiveView('terminal')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeView === 'terminal' 
              ? 'bg-[#1e1e1e] text-white border-t-2 border-blue-500' 
              : 'text-gray-400 hover:text-gray-200 hover:bg-[#3d3d3d]'
          }`}
        >
          <LucideTerminal size={16} />
          Terminal
        </button>
        <button
          onClick={() => setActiveView('tree')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeView === 'tree' 
              ? 'bg-[#1e1e1e] text-white border-t-2 border-blue-500' 
              : 'text-gray-400 hover:text-gray-200 hover:bg-[#3d3d3d]'
          }`}
        >
          <FolderTree size={16} />
          File Tree
        </button>
        <button
          onClick={() => setActiveView('editor')}
          disabled={!editingFile}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeView === 'editor' 
              ? 'bg-[#1e1e1e] text-white border-t-2 border-blue-500' 
              : editingFile 
                ? 'text-gray-400 hover:text-gray-200 hover:bg-[#3d3d3d]'
                : 'text-gray-600 cursor-not-allowed'
          }`}
        >
          <FileCode size={16} />
          Editor {editingFile ? `(${editingFile.split('/').pop()})` : ''}
        </button>
        <button
          onClick={() => setActiveView('agent')}
          className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeView === 'agent' 
              ? 'bg-[#1e1e1e] text-white border-t-2 border-blue-500' 
              : 'text-gray-400 hover:text-gray-200 hover:bg-[#3d3d3d]'
          }`}
        >
          <Bot size={16} />
          Agent
        </button>
        <button
          onClick={() => setActiveView('settings')}
          className={`ml-auto flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
            activeView === 'settings' 
              ? 'bg-[#1e1e1e] text-white border-t-2 border-blue-500' 
              : 'text-gray-400 hover:text-gray-200 hover:bg-[#3d3d3d]'
          }`}
          aria-label="Storage settings"
        >
          <Settings size={16} />
          Storage{fsInfo ? ` (${fsInfo.backend})` : ''}
        </button>
      </div>

      {fsInfo && !fsInfo.isPrimaryTab && (
        <div role="alert" className="bg-yellow-900 text-yellow-100 text-sm px-4 py-2">
          Filesystem already open in another tab — tabs don&apos;t share changes and the last write wins. Use one tab at a time.
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 relative overflow-hidden bg-[#1e1e1e]">
        {!fsReady && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400">
            Initializing FileSystem...
          </div>
        )}

        {/* Terminal View - Always mounted to preserve state */}
        <div 
          className={`absolute inset-0 ${activeView === 'terminal' ? 'z-10' : 'z-0 invisible'}`}
        >
          {fsReady && sandboxRef.current && (
            <Terminal
              sandbox={sandboxRef.current}
              events={events}
              readOnly={fsInfo ? !fsInfo.isPrimaryTab : false}
            />
          )}
        </div>

        {/* Agent View - Always mounted to preserve chat state */}
        <div 
          className={`absolute inset-0 ${activeView === 'agent' ? 'z-10' : 'z-0 invisible'}`}
        >
          {fsReady && (
            <AgentPanel
              getSandbox={() => sandboxRef.current}
              events={events}
            />
          )}
        </div>

        {/* File Tree - always mounted: fs:changed keeps it fresh across views */}
        <div 
          className={`absolute inset-0 ${activeView === 'tree' ? 'z-10' : 'z-0 invisible'}`}
        >
          {fsReady && <FileTree onSelectFile={handleFileSelect} events={events} />}
        </div>

        {/* Editor - mounted while a file is open, so external changes land even when hidden */}
        {editingFile && (
          <div className={`absolute inset-0 ${activeView === 'editor' ? 'z-10' : 'z-0 invisible'}`}>
            <Editor 
              filepath={editingFile} 
              onClose={handleCloseEditor} 
              events={events}
              readOnly={fsInfo ? !fsInfo.isPrimaryTab : false}
            />
          </div>
        )}
        
        {activeView === 'editor' && !editingFile && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-gray-400">
            No file open. Select a file from the File Tree or use 'edit' command.
          </div>
        )}

        {/* Storage Settings View */}
        {activeView === 'settings' && fsInfo && (
          <div className="absolute inset-0 z-10">
            <StorageSettings backend={fsInfo.backend} isPrimaryTab={fsInfo.isPrimaryTab} />
          </div>
        )}
      </div>
    </main>
  );
}
