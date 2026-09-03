'use client';

/**
 * Workspace shell (spa-ui-plan U3): top bar (badges, tabs, publish,
 * terminal), the console panel, and the pod session boot via
 * PodSessionService. Panels (tree/editor/agent/settings) land in U4 —
 * the terminal is fully live now, so every S5.5-era verification runs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import dynamicImport from 'next/dynamic';
import { useStore } from 'zustand';
import { Terminal as LucideTerminal, Home as HomeIcon, FolderTree, FileCode, Bot, Settings, UploadCloud } from 'lucide-react';
import { workspaceStore, initialWorkspace, patchPublish, setView, setEditingFile, type ViewMode } from '@/lib/stores/workspace';
import { openPodSession, type PodSession } from '@/lib/services/pod-session';
import { OPEN_DRAFT_TIP, actorId, isOpenRef, setOpenTag, type Route } from '@/lib/boot';
import { navClick } from '@/lib/stores/route';
import EncryptionBadge from '@/components/EncryptionBadge';
import OfflineToggle from '@/components/OfflineToggle';
import SyncStatus from '@/components/SyncStatus';
import FileTree from '@/components/FileTree';
import Editor from '@/components/Editor';
import StorageSettings from '@/components/StorageSettings';
import AgentPanel from '@/components/AgentPanel';
import LayersView from '@/components/LayersView';
import { Layers as LayersIcon } from 'lucide-react';

const Terminal = dynamicImport(() => import('@/components/Terminal'), { ssr: false });

export default function Workspace({ route }: { route: Route }) {
  const snap = useStore(workspaceStore);
  const [termOpen, setTermOpen] = useState(false);
  const [termHeight, setTermHeight] = useState(300);
  const sessionRef = useRef<PodSession | null>(null);
  const [sessionTick, setSessionTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let opened: PodSession | null = null;
    // Show "Opening…" NOW — the boot itself queues behind the previous
    // session's serialized close (flush-push included).
    workspaceStore.setState({ ...initialWorkspace, syncActive: route.isRef && route.mode === 'rw' });
    void openPodSession(route)
      .then((session) => {
        if (cancelled) return void session.close();
        opened = session;
        sessionRef.current = session;
        setSessionTick((t) => t + 1);
      })
      .catch((e) => {
        console.error('workspace boot failed:', e);
        workspaceStore.setState({ phase: 'error', error: (e as Error).message });
      });
    return () => {
      // U5: leaving the route closes the session — flush-push, unsubscribe,
      // pod.dispose (overlays + proc providers), Web Lock release.
      cancelled = true;
      sessionRef.current = null;
      void opened?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.id, route.isRef]);

  // iOS Safari: mirror the visual viewport into --app-height.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      if (vv.scale !== 1) return;
      document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
      window.scrollTo(0, 0);
    };
    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, []);

  // ctrl+` slides the console up/down
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.code === 'Backquote' || e.key === '`')) {
        e.preventDefault();
        setTermOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const onDividerPointerDown = useCallback((down: React.PointerEvent) => {
    down.preventDefault();
    const startY = down.clientY;
    setTermHeight((startHeight) => {
      const move = (e: PointerEvent) => {
        setTermHeight(Math.min(Math.max(startHeight + (startY - e.clientY), 120), window.innerHeight * 0.8));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      return startHeight;
    });
  }, []);

  const openPublish = () => {
    patchPublish({ open: true, notice: null, value: route.isRef ? route.id : `me/${route.id}:_1` });
    void sessionRef.current?.suggestPublishValue().then((value) => patchPublish({ value }));
  };

  const submitPublish = () => {
    void (async () => {
      const session = sessionRef.current;
      const target = snap.publish.value.trim();
      if (!session || snap.publish.publishing || !target) return;
      patchPublish({ publishing: true, notice: null });
      try {
        patchPublish({ notice: await session.publish(target) });
      } catch (e) {
        patchPublish({ notice: `publish: ${(e as Error).message}` });
      } finally {
        patchPublish({ publishing: false });
      }
    })();
  };

  const tab = (view: ViewMode, icon: React.ReactNode, label: string, disabled = false) => (
    <button
      onClick={() => setView(view)}
      disabled={disabled}
      title={label}
      className={`flex shrink-0 items-center gap-2 px-2.5 py-3 text-sm font-medium transition-colors sm:px-4 ${
        snap.activeView === view
          ? 'border-t-2 border-blue-500 bg-[#1e1e1e] text-white'
          : disabled
            ? 'cursor-not-allowed text-gray-600'
            : 'text-gray-400 hover:bg-[#3d3d3d] hover:text-gray-200'
      }`}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );

  const ready = snap.phase === 'ready' && sessionTick > 0 && !!sessionRef.current;

  return (
    <main className="flex h-[var(--app-height)] flex-col overflow-hidden bg-black pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] text-white">
      <div className="flex items-center border-b border-gray-700 bg-[#2d2d2d] px-2">
        {/* U5: client-side — the session closes (flush + dispose) on the way out.
            Not next/link: our router owns the transition (href kept for new-tab). */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          onClick={(e) => navClick(e)}
          className="flex items-center gap-2 px-3 py-3 text-sm font-medium text-gray-400 hover:bg-[#3d3d3d] hover:text-gray-200"
          aria-label="All artipods"
        >
          <HomeIcon size={16} />
        </a>
        <span className="min-w-0 max-w-[7rem] truncate px-2 font-mono text-sm text-gray-300 sm:max-w-[14rem]" title={route.id}>
          {route.isRef ? (route.mode === 'cow' ? `fork of ${route.id}` : route.id) : `blank ${route.id}`}
          {route.mode !== 'rw' && <span className="ml-1.5 rounded border border-gray-600 px-1 text-[10px] uppercase text-gray-400">{route.mode}</span>}
        </span>
        <span className="hidden shrink-0 items-center gap-1.5 px-1 sm:inline-flex">
          <EncryptionBadge principal={actorId} />
          <SyncStatus />
          <OfflineToggle />
        </span>
        {tab('tree', <FolderTree size={16} />, 'Files')}
        {tab('editor', <FileCode size={16} />, `Editor${snap.editingFile ? ` (${snap.editingFile.split('/').pop()})` : ''}`, !snap.editingFile)}
        {tab('agent', <Bot size={16} />, 'Agent')}
        <div className="ml-auto flex items-center">
          {route.mode !== 'ro' && (
            <button
              onClick={openPublish}
              title="Publish this workspace to the server (also: `artipod publish` in the terminal)"
              className="flex shrink-0 items-center gap-2 px-2.5 py-3 text-sm font-medium text-gray-400 transition-colors hover:bg-[#3d3d3d] hover:text-gray-200 sm:px-4"
            >
              <UploadCloud size={16} />
              <span className="hidden sm:inline">{snap.publish.publishing ? 'Publishing…' : 'Publish'}</span>
            </button>
          )}
          <button
            onClick={() => setTermOpen((o) => !o)}
            title="Toggle terminal (ctrl+`)"
            className={`flex shrink-0 items-center gap-2 px-2.5 py-3 text-sm font-medium transition-colors sm:px-4 ${
              termOpen ? 'text-white' : 'text-gray-400 hover:bg-[#3d3d3d] hover:text-gray-200'
            }`}
          >
            <LucideTerminal size={16} />
            <span className="hidden sm:inline">Terminal</span>
            <kbd className="hidden rounded border border-gray-600 bg-[#3d3d3d] px-1 font-mono text-[10px] md:inline">ctrl+`</kbd>
          </button>
          {tab('settings', <Settings size={16} />, `Storage${snap.backend ? ` (${snap.backend})` : ''}`)}
        </div>
      </div>

      {!snap.isPrimaryTab && (
        <div role="alert" className="bg-yellow-900 px-4 py-2 text-sm text-yellow-100">
          Filesystem already open in another tab — tabs don&apos;t share changes and the last write wins. Use one tab at a time.
        </div>
      )}

      {snap.publish.open && (
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-700 bg-[#252526] px-4 py-2">
          <span className="basis-full text-xs text-gray-400 sm:shrink-0 sm:basis-auto">
            {route.isRef ? `publish — keep “${route.id}” to push back, or a new name:tag to branch:` : 'publish this workspace as:'}
          </span>
          <input
            autoFocus
            value={snap.publish.value}
            onChange={(e) => patchPublish({ value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPublish();
              if (e.key === 'Escape') patchPublish({ open: false });
            }}
            className="min-w-0 flex-1 rounded border border-gray-600 bg-transparent px-2 py-1 font-mono text-sm text-gray-200"
          />
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-300" title={OPEN_DRAFT_TIP}>
            <input
              type="checkbox"
              checked={isOpenRef(snap.publish.value)}
              onChange={(e) => patchPublish({ value: setOpenTag(snap.publish.value, e.target.checked) })}
            />
            open draft
          </label>
          <button
            onClick={submitPublish}
            disabled={snap.publish.publishing || !snap.publish.value.trim()}
            className="rounded bg-blue-700 px-3 py-1 text-sm hover:bg-blue-600 disabled:opacity-40"
          >
            {snap.publish.publishing ? 'Publishing…' : 'Publish'}
          </button>
          <button onClick={() => patchPublish({ open: false })} className="px-2 py-1 text-sm text-gray-400 hover:text-white">
            ✕
          </button>
        </div>
      )}
      {snap.publish.notice && (
        <div role="status" className="flex justify-between border-b border-emerald-900 bg-[#1b2a1b] px-4 py-2 text-sm text-emerald-200">
          <span className="font-mono">{snap.publish.notice}</span>
          <button onClick={() => patchPublish({ notice: null })} className="text-emerald-400 hover:text-white">✕</button>
        </div>
      )}

      <div className="relative flex-1 overflow-hidden bg-[#1e1e1e]">
        {snap.phase === 'opening' && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400">
            Opening {route.isRef ? route.id : `blank workspace ${route.id}`}…
          </div>
        )}
        {snap.phase === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-red-300">
            workspace boot failed: {snap.error}
          </div>
        )}

        {/* Agent — always mounted to preserve chat state */}
        <div className={`absolute inset-0 ${snap.activeView === 'agent' ? 'z-10' : 'invisible z-0'}`}>
          {ready && (
            <AgentPanel
              getSandbox={() => sessionRef.current?.sandbox ?? null}
              events={sessionRef.current?.events}
              getLoopOptions={() => sessionRef.current?.pod.agentLoopOptions() ?? {}}
            />
          )}
        </div>

        {/* File tree — always mounted: fs:changed keeps it fresh across views */}
        <div className={`absolute inset-0 ${snap.activeView === 'tree' ? 'z-10' : 'invisible z-0'}`}>
          {ready && (
            <FileTree
              onSelectFile={(path) => setEditingFile(path)}
              events={sessionRef.current?.events}
              roots={[snap.root]}
              headerExtra={
                <button
                  onClick={() => setView('layers')}
                  className="flex items-center gap-1 rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600"
                  title="The pod's layer stack (basis + local upper)"
                >
                  <LayersIcon size={12} /> Layers
                </button>
              }
              getDehydratedPaths={async () => {
                const pod = sessionRef.current?.pod;
                if (!pod?.hydrator || !pod.basis) return [];
                const paths = await pod.hydrator.dehydratedPaths(pod.basis.ref);
                return paths.map((p) => `${pod.basis!.at}${p}`);
              }}
            />
          )}
        </div>

        {/* Editor — mounted while a file is open, so external changes land even when hidden */}
        {snap.editingFile && (
          <div className={`absolute inset-0 ${snap.activeView === 'editor' ? 'z-10' : 'invisible z-0'}`}>
            <Editor
              filepath={snap.editingFile}
              onClose={() => {
                setEditingFile(null);
                setView('tree');
              }}
              events={sessionRef.current?.events}
              readOnly={route.mode === 'ro' || !snap.isPrimaryTab}
            />
          </div>
        )}
        {snap.activeView === 'editor' && !snap.editingFile && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-gray-400">
            No file open. Select a file from Files or use the <code className="mx-1">edit</code> command.
          </div>
        )}

        {snap.activeView === 'settings' && snap.backend && (
          <div className="absolute inset-0 z-10">
            <StorageSettings backend={snap.backend as never} isPrimaryTab={snap.isPrimaryTab} />
          </div>
        )}

        {snap.activeView === 'layers' && (
          <div className="absolute inset-0 z-10 overflow-auto">
            <LayersView route={route} ready={ready} onPublish={route.mode !== 'ro' ? openPublish : undefined} onBack={() => setView('tree')} />
          </div>
        )}
      </div>

      <div className="shrink-0 overflow-hidden border-t border-gray-700 bg-[#1e1e1e]" style={{ height: termOpen ? termHeight : 0 }}>
        <div onPointerDown={onDividerPointerDown} className="h-1.5 cursor-row-resize bg-[#2d2d2d] transition-colors hover:bg-blue-500" title="Drag to resize" />
        <div style={{ height: termOpen ? termHeight - 6 : 0 }}>
          {ready && sessionRef.current && (
            <Terminal sandbox={sessionRef.current.sandbox} events={sessionRef.current.events} readOnly={route.mode === 'ro' || !snap.isPrimaryTab} />
          )}
        </div>
      </div>
    </main>
  );
}
