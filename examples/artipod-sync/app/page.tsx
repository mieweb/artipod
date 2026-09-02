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
import { Terminal as LucideTerminal, FolderTree, FileCode, Settings, Bot, Home as HomeIcon } from 'lucide-react';

// Dynamically import Terminal to avoid SSR issues with xterm.js
const Terminal = dynamicImport(() => import('@/components/Terminal'), {
  ssr: false,
});

export const dynamic = 'force-dynamic';

type ViewMode = 'home' | 'terminal' | 'tree' | 'editor' | 'settings' | 'agent';

/** undefined = start screen pending; null = blank workspace; string = basis ref. */
type BasisChoice = string | null | undefined;

export default function Home() {
  const [fsReady, setFsReady] = useState(false);
  const [fsInfo, setFsInfo] = useState<InitResult | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ViewMode>('home');
  const [availableRefs, setAvailableRefs] = useState<string[] | null>(null);
  const [basisChoice, setBasisChoice] = useState<BasisChoice>(undefined);
  // Blank workspaces are per-id (/work/<id>) so "Blank workspace" is truly
  // blank every time; the id rides the route, so the URL reopens the same one.
  const [blankId, setBlankId] = useState<string | null>(null);
  const routed = useRef(false);
  const [workspaceRoot, setWorkspaceRoot] = useState('/repo');
  const sandboxRef = useRef<Sandbox | null>(null);
  const podRef = useRef<Awaited<ReturnType<typeof import('@artipod/core').createZenFsPod>> | null>(null);
  // One event bus per pod: terminal, tree, editor and agent stay coherent.
  const eventsRef = useRef<PodEvents | null>(null);
  if (!eventsRef.current) eventsRef.current = new PodEvents();
  const events = eventsRef.current;

  const openPod = (ref: string) => {
    window.history.replaceState(null, '', `#/pod/${encodeURIComponent(ref)}`);
    setBasisChoice(ref);
  };
  const startBlank = (id = crypto.randomUUID().slice(0, 8)) => {
    window.history.replaceState(null, '', `#/new/${id}`);
    setBlankId(id);
    setBasisChoice(null);
  };

  // Routes (static export → hash): #/pod/<ref> opens that artipod directly,
  // #/new/<id> reopens a specific blank workspace.
  useEffect(() => {
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash.startsWith('/pod/')) {
      routed.current = true;
      setBasisChoice(hash.slice('/pod/'.length));
    } else if (hash.startsWith('/new/')) {
      routed.current = true;
      const id = hash.slice('/new/'.length) || crypto.randomUUID().slice(0, 8);
      setBlankId(id);
      setBasisChoice(null);
    }
  }, []);

  // The demo's front door: published artipods on this server (sync plan D).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/pods/refs');
        const refs = res.ok ? ((await res.json()) as { ref: string }[]).map((r) => r.ref) : [];
        if (cancelled) return;
        setAvailableRefs(refs);
        if (refs.length === 0 && !routed.current) startBlank(); // nothing published — skip the picker
      } catch {
        if (!cancelled) {
          setAvailableRefs([]);
          if (!routed.current) startBlank();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (basisChoice === undefined) return; // start screen still open
    let cancelled = false;
    (async () => {
      const info = await initFileSystem();
      // just-bash + the pod layer load lazily so they stay out of the first-load bundle
      const [{ createZenFsPod }, { ArtipodRegistryProxyTransport }, { HttpPodStore }, { fs }] = await Promise.all([
        import('@artipod/core'),
        import('@artipod/core/oci'),
        import('@artipod/core/manager'),
        import('@/lib/filesystem'),
      ]);
      if (cancelled) return;
      setFsInfo(info);
      // Each blank workspace gets its own fresh root; a basis brings its own.
      const blankRoot = `/work/${blankId ?? 'scratch'}`;
      if (!basisChoice) await fs.promises.mkdir(blankRoot, { recursive: true }).catch(() => {});
      // PAT prompt for git push/fetch to private repos (token kept off the sandbox fs)
      const { setAuthPrompt } = await import('@/lib/git-auth');
      setAuthPrompt(async (origin) =>
        window.prompt(`Personal access token for ${origin} (stored in memory):`),
      );
      // Phase 3: the app's layout is a declarative manifest; initFileSystem
      // already realized the store (backend choice, migration, tab lock), so
      // the pod adopts it. The manifest shows up at /proc/pod/manifest.json.
      const pod = await createZenFsPod(
        {
          mounts: [
            {
              name: 'root',
              path: '/',
              source: { kind: 'backend', backend: info?.backend ?? 'indexeddb' },
              mode: 'rw',
            },
          ],
        },
        {
          adopt: fs,
          events,
          // A chosen basis becomes the workspace (cwd follows the overlay).
          cwd: basisChoice ? undefined : blankRoot,
          // browser pulls go through the /api/oci relay (allowlist server-side)
          oci: { transport: new ArtipodRegistryProxyTransport('/api/oci') },
          // push/pull/clone talk to this deployment's manager store
          sync: {
            remote: new HttpPodStore('/api/pods'),
            // stable per-profile LWW identity (Decision D8)
            actor: (() => {
              const key = 'artipod-actor';
              let actor = localStorage.getItem(key);
              if (!actor) {
                actor = `browser:${crypto.randomUUID().slice(0, 8)}`;
                localStorage.setItem(key, actor);
              }
              return actor;
            })(),
            ...(basisChoice ? { basis: { ref: basisChoice } } : {}),
          },
          // The demo reads transparently hydrate (sync plan D6); find/ls stay zero-fetch.
          hydration: {
            policy: { default: 'lazy' },
            onDemand: 'fetch',
            ...(basisChoice ? { defaultRef: basisChoice } : {}),
          },
          onEdit: (path) => {
            setEditingFile(path);
            setActiveView('editor');
          },
        },
      );
      sandboxRef.current = pod.createSandbox();
      podRef.current = pod;
      // demo/debug escape hatch (see docs/console.md's future replacement)
      (window as unknown as { __artipod?: unknown }).__artipod = pod;
      if (pod.basis) setWorkspaceRoot(pod.basis.at);
      else setWorkspaceRoot(blankRoot);
      setFsReady(true);
    })().catch((e) => console.error('Sandbox init failed:', e));
    return () => {
      cancelled = true;
    };
  }, [basisChoice, blankId]);

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

  // ctrl+` toggles the terminal (the VS Code muscle memory)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.code === 'Backquote' || e.key === '`')) {
        e.preventDefault();
        setActiveView((view) => (view === 'terminal' ? 'home' : 'terminal'));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <main className="flex h-[var(--app-height)] flex-col bg-black text-white overflow-hidden pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {/* Navigation Bar — tool chrome only; Home stays a simple page */}
      {activeView !== 'home' && (
      <div className="flex items-center bg-[#2d2d2d] border-b border-gray-700 px-2">
        <button
          onClick={() => setActiveView('home')}
          className="flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors text-gray-400 hover:text-gray-200 hover:bg-[#3d3d3d]"
          aria-label="Home"
        >
          <HomeIcon size={16} />
          Home
        </button>
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
      )}

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

        {/* Start screen (sync plan D): pick a published artipod as the basis */}
        {basisChoice === undefined && (availableRefs?.length ?? 0) > 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#1e1e1e]">
            <div className="w-full max-w-md rounded-lg border border-gray-700 bg-[#252526] p-6">
              <h2 className="text-lg font-bold mb-1">Open an artipod</h2>
              <p className="text-sm text-gray-400 mb-4">
                This server publishes folders as artipods. Opening one adds a writable layer on top —
                files list instantly and download only when read.
              </p>
              <ul className="space-y-2 mb-4">
                {availableRefs!.map((ref) => (
                  <li key={ref}>
                    <button
                      onClick={() => openPod(ref)}
                      className="w-full text-left px-3 py-2 rounded bg-[#333] hover:bg-[#3d3d3d] font-mono text-sm"
                    >
                      {ref}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                onClick={() => startBlank()}
                className="w-full px-3 py-2 rounded border border-gray-600 text-gray-300 hover:bg-[#333] text-sm"
              >
                Blank workspace
              </button>
            </div>
          </div>
        )}

        {/* Home: the simple landing — the tools are one keystroke/click away */}
        <div className={`absolute inset-0 overflow-auto ${activeView === 'home' ? 'z-10' : 'z-0 invisible'}`}>
          {fsReady && (
            <div className="flex min-h-full items-center justify-center p-6">
              <div className="w-full max-w-lg">
                <h1 className="text-2xl font-bold mb-1">artipod</h1>
                <p className="text-gray-400 text-sm mb-6">
                  a pod for artifacts — files that version, sync, and run tools, right here in the browser.
                </p>
                <div className="rounded-lg border border-gray-700 bg-[#252526] p-4 mb-6 font-mono text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-gray-400">workspace</span>
                    <span>{basisChoice ?? `blank ${blankId ?? ''}`}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-gray-400">root</span>
                    <span>{workspaceRoot}</span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-gray-400">url</span>
                    <span className="truncate">{typeof window !== 'undefined' ? window.location.hash || '#' : '#'}</span>
                  </div>
                </div>
                <ul className="space-y-2 text-sm text-gray-300">
                  <li>
                    <button onClick={() => setActiveView('terminal')} className="text-blue-400 hover:underline">
                      Open the terminal
                    </button>{' '}
                    — or press <kbd className="px-1.5 py-0.5 rounded bg-[#333] border border-gray-600 font-mono">ctrl+`</kbd> anytime
                  </li>
                  <li>
                    <button onClick={() => setActiveView('tree')} className="text-blue-400 hover:underline">
                      Browse the files
                    </button>{' '}
                    — reads hydrate lazily from the server
                  </li>
                  <li>
                    <button onClick={() => setActiveView('agent')} className="text-blue-400 hover:underline">
                      Ask the agent
                    </button>{' '}
                    — it uses the same pod and terminal
                  </li>
                  <li>
                    <button onClick={() => setActiveView('settings')} className="text-blue-400 hover:underline">
                      Storage settings
                    </button>
                    {fsInfo ? ` — ${fsInfo.backend}` : ''}
                  </li>
                  <li>
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        window.history.replaceState(null, '', '#');
                        window.location.reload();
                      }}
                      className="text-blue-400 hover:underline"
                    >
                      Switch artipod
                    </a>{' '}
                    — back to the picker
                  </li>
                </ul>
              </div>
            </div>
          )}
        </div>

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
              getLoopOptions={() => podRef.current?.agentLoopOptions() ?? {}}
            />
          )}
        </div>

        {/* File Tree - always mounted: fs:changed keeps it fresh across views */}
        <div 
          className={`absolute inset-0 ${activeView === 'tree' ? 'z-10' : 'z-0 invisible'}`}
        >
          {fsReady && (
            <FileTree
              onSelectFile={handleFileSelect}
              events={events}
              roots={[workspaceRoot]}
              getDehydratedPaths={async () => {
                const pod = podRef.current;
                if (!pod?.hydrator || !pod.basis) return [];
                // basis paths are view-relative; the tree shows them under the overlay
                const paths = await pod.hydrator.dehydratedPaths(pod.basis.ref);
                return paths.map((p) => `${pod.basis!.at}${p}`);
              }}
            />
          )}
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
            No file open. Select a file from the File Tree or use the <code className="mx-1">edit</code> command.
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
