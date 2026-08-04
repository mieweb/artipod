'use client';

import { useEffect, useState, useRef } from 'react';
import dynamicImport from 'next/dynamic';
import { initFileSystem } from '@/lib/filesystem';
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
  const termWriteRef = useRef<((text: string) => void) | null>(null);

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

  const handleCommand = async (cmd: string, signal: AbortSignal) => {
    if (!sandboxRef.current) {
      return { stdout: '', stderr: 'FileSystem not ready\n', exitCode: 1 };
    }
    return sandboxRef.current.exec(cmd, { signal });
  };

  const handleComplete = async (line: string) => {
    if (!sandboxRef.current) return { candidates: [], replaceStart: line.length };
    return sandboxRef.current.complete(line);
  };

  const getPrompt = () => sandboxRef.current?.getCwd() ?? '';

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
          {fsReady && (
            <Terminal
              onCommand={handleCommand}
              getPrompt={getPrompt}
              onComplete={handleComplete}
              registerWriter={(write) => {
                termWriteRef.current = write;
              }}
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
              echoToTerminal={(text) => termWriteRef.current?.(text)}
            />
          )}
        </div>

        {/* File Tree View */}
        {fsReady && activeView === 'tree' && (
          <div className="absolute inset-0 z-10">
            <FileTree onSelectFile={handleFileSelect} />
          </div>
        )}

        {/* Editor View */}
        {activeView === 'editor' && editingFile && (
          <div className="absolute inset-0 z-10">
            <Editor 
              filepath={editingFile} 
              onClose={handleCloseEditor} 
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
