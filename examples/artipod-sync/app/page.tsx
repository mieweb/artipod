'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import dynamicImport from 'next/dynamic';
import { initFileSystem } from '@/lib/filesystem';
import { PodEvents } from '@artipod/core/host';
import type { Sandbox } from '@/lib/sandbox/types';
import type { InitResult } from '@/lib/sandbox/storage';
import Editor from '@/components/Editor';
import FileTree from '@/components/FileTree';
import StorageSettings from '@/components/StorageSettings';
import AgentPanel from '@/components/AgentPanel';
import { Terminal as LucideTerminal, FolderTree, FileCode, Settings, Bot, Home as HomeIcon, Plus, Server, HardDrive } from 'lucide-react';

// Dynamically import Terminal to avoid SSR issues with xterm.js
const Terminal = dynamicImport(() => import('@/components/Terminal'), {
  ssr: false,
});

export const dynamic = 'force-dynamic';

/**
 * Routing (?artipod=<ref-or-id>, static-export friendly):
 *   /                     → the catalog (server + local artipods, new blank)
 *   /?artipod=me/play:1   → workspace over that published pod (refs contain ':')
 *   /?artipod=71702f6e    → workspace over blank /work/71702f6e
 */
interface Route {
  id: string;
  isRef: boolean;
}

const workspaceUrl = (id: string): string => `/?artipod=${encodeURIComponent(id)}`;

/** Workspaces this browser has opened before (the "on this machine" list). */
interface LocalEntry {
  id: string;
  kind: 'pod' | 'blank';
  lastOpened: number;
}

const REGISTRY_KEY = 'artipod-workspaces';

function readRegistry(): LocalEntry[] {
  try {
    return JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? '[]') as LocalEntry[];
  } catch {
    return [];
  }
}

function recordWorkspace(id: string, kind: 'pod' | 'blank'): void {
  const rest = readRegistry().filter((e) => e.id !== id);
  localStorage.setItem(REGISTRY_KEY, JSON.stringify([{ id, kind, lastOpened: Date.now() }, ...rest].slice(0, 50)));
}

function dropFromRegistry(ids: string[]): void {
  if (ids.length === 0) return;
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(readRegistry().filter((e) => !ids.includes(e.id))));
}

const wsLockName = (id: string): string => `artipod-ws-${id}`;

/** Ids whose workspace tab is still alive (it holds a Web Lock for its lifetime). */
async function liveWorkspaceIds(): Promise<Set<string>> {
  try {
    const { held } = await navigator.locks.query();
    return new Set(
      (held ?? [])
        .map((l) => l.name ?? '')
        .filter((n) => n.startsWith('artipod-ws-'))
        .map((n) => n.slice('artipod-ws-'.length)),
    );
  } catch {
    return new Set(); // no Web Locks — skip sweeping rather than risk a live tab
  }
}

export default function Page() {
  // undefined = parsing; null = catalog; Route = workspace
  const [route, setRoute] = useState<Route | null | undefined>(undefined);

  useEffect(() => {
    // legacy hash routes → query form
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (hash.startsWith('/pod/')) return window.location.replace(workspaceUrl(hash.slice('/pod/'.length)));
    if (hash.startsWith('/new/')) return window.location.replace(workspaceUrl(hash.slice('/new/'.length)));
    const id = new URLSearchParams(window.location.search).get('artipod');
    setRoute(id ? { id, isRef: id.includes(':') } : null);
  }, []);

  if (route === undefined) return <main className="h-[var(--app-height)] bg-black" />;
  if (route === null) return <Catalog />;
  return <Workspace route={route} />;
}

/** `/` — every artipod in reach: this server's, this machine's, or a new blank one. */
function Catalog() {
  const [serverRefs, setServerRefs] = useState<string[] | null>(null);
  const [local, setLocal] = useState<LocalEntry[]>([]);
  // refs with actual local changes: a non-empty overlay upper (/.artipod/upper/<ref>)
  const [changedRefs, setChangedRefs] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/pods/refs');
        setServerRefs(res.ok ? ((await res.json()) as { ref: string }[]).map((r) => r.ref) : []);
      } catch {
        setServerRefs([]);
      }
    })();
    // "On this machine" = the filesystem's /work dirs (source of truth),
    // enriched with the localStorage registry (lastOpened, opened pod refs).
    // Create-on-write (same rule as the CLI's kept pods): an EMPTY blank
    // whose tab is gone was never used — sweep it instead of listing it.
    (async () => {
      const registry = readRegistry();
      const onDisk: string[] = [];
      const swept: string[] = [];
      try {
        await initFileSystem();
        const { fs } = await import('@/lib/filesystem');
        const dirs = (await fs.promises.readdir('/work').catch(() => [])) as string[];
        const live = await liveWorkspaceIds();
        for (const id of dirs) {
          const entries = (await fs.promises.readdir(`/work/${id}`).catch(() => null)) as string[] | null;
          if (entries && entries.length === 0 && !live.has(id)) {
            await fs.promises.rm(`/work/${id}`, { recursive: true }).catch(() => {});
            swept.push(id);
          } else {
            onDisk.push(id);
          }
        }
        dropFromRegistry(swept);
        // "local layer" = the overlay upper holds writes, not merely "was opened"
        const uppers = (await fs.promises.readdir('/.artipod/upper').catch(() => [])) as string[];
        const changed = new Set<string>();
        for (const name of uppers) {
          const entries = (await fs.promises.readdir(`/.artipod/upper/${name}`).catch(() => [])) as string[];
          if (entries.length > 0) changed.add(decodeURIComponent(name));
        }
        setChangedRefs(changed);
      } catch {
        // no /work yet (or init failed) — registry alone
      }
      const byId = new Map<string, LocalEntry>(
        registry.filter((e) => !swept.includes(e.id) && (e.kind === 'pod' || onDisk.includes(e.id))).map((e) => [e.id, e]),
      );
      for (const id of onDisk) {
        if (!byId.has(id)) byId.set(id, { id, kind: 'blank', lastOpened: 0 });
      }
      setLocal(Array.from(byId.values()).sort((a, b) => b.lastOpened - a.lastOpened));
    })();
  }, []);

  const localById = new Map(local.map((e) => [e.id, e]));
  const localOnly = local.filter((e) => !serverRefs?.includes(e.id));

  const row = (id: string, badge: React.ReactNode, note: string) => (
    <li key={id}>
      {/* full reload on purpose: a workspace boots its FS once per page */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href={workspaceUrl(id)}
        className="flex items-center justify-between gap-3 px-3 py-2 rounded bg-[#333] hover:bg-[#3d3d3d] text-sm"
      >
        <span className="font-mono truncate">{id}</span>
        <span className="flex items-center gap-2 shrink-0 text-xs text-gray-400">
          {note && <span>{note}</span>}
          {badge}
        </span>
      </a>
    </li>
  );

  return (
    <main className="h-[var(--app-height)] overflow-auto bg-black text-white">
      <div className="mx-auto max-w-lg p-6">
        <h1 className="text-2xl font-bold mb-1">artipod</h1>
        <p className="text-gray-400 text-sm mb-6">
          a pod for artifacts — files that version, sync, and run tools, right here in the browser.
        </p>

        <h2 className="text-sm font-semibold text-gray-300 mb-2 flex items-center gap-2">
          <Server size={14} /> On this server
        </h2>
        {serverRefs === null ? (
          <p className="text-sm text-gray-500 mb-6">loading…</p>
        ) : serverRefs.length === 0 ? (
          <p className="text-sm text-gray-500 mb-6">
            nothing published — <code>artipod serve --publish &lt;dir&gt;</code>
          </p>
        ) : (
          <ul className="space-y-2 mb-6">
            {serverRefs.map((ref) => {
              const opened = localById.get(ref);
              return row(
                ref,
                <>
                  {/* the overlay auto-pushes (~2s debounce): a non-empty upper is
                      UNPUSHED work; opened + empty upper means fully synced */}
                  {changedRefs.has(ref) ? (
                    <span className="rounded bg-emerald-900/60 px-1.5 py-0.5">local changes</span>
                  ) : (
                    opened && <span className="rounded bg-gray-700 px-1.5 py-0.5">synced</span>
                  )}
                  <span className="rounded bg-blue-900/60 px-1.5 py-0.5">server</span>
                </>,
                opened?.lastOpened ? new Date(opened.lastOpened).toLocaleDateString() : '',
              );
            })}
          </ul>
        )}

        <h2 className="text-sm font-semibold text-gray-300 mb-2 flex items-center gap-2">
          <HardDrive size={14} /> On this machine
        </h2>
        {localOnly.length === 0 ? (
          <p className="text-sm text-gray-500 mb-6">no local workspaces yet</p>
        ) : (
          <ul className="space-y-2 mb-6">
            {localOnly.map((e) =>
              row(
                e.id,
                <span className="rounded bg-emerald-900/60 px-1.5 py-0.5">{e.kind === 'blank' ? 'blank' : 'local'}</span>,
                e.lastOpened ? new Date(e.lastOpened).toLocaleDateString() : '',
              ),
            )}
          </ul>
        )}

        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href={workspaceUrl(crypto.randomUUID().slice(0, 8))}
          className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded border border-gray-600 text-gray-300 hover:bg-[#333] text-sm"
        >
          <Plus size={14} /> New blank workspace
        </a>
      </div>
    </main>
  );
}

type ViewMode = 'tree' | 'editor' | 'settings' | 'agent';

function Workspace({ route }: { route: Route }) {
  const [fsReady, setFsReady] = useState(false);
  const [fsInfo, setFsInfo] = useState<InitResult | null>(null);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<ViewMode>('tree');
  const [workspaceRoot, setWorkspaceRoot] = useState('/');
  // The terminal is a console panel sliding up from the bottom (ctrl+`), resizable.
  const [termOpen, setTermOpen] = useState(false);
  const [termHeight, setTermHeight] = useState(300);
  const sandboxRef = useRef<Sandbox | null>(null);
  const podRef = useRef<Awaited<ReturnType<typeof import('@artipod/core').createZenFsPod>> | null>(null);
  // One event bus per pod: terminal, tree, editor and agent stay coherent.
  const eventsRef = useRef<PodEvents | null>(null);
  if (!eventsRef.current) eventsRef.current = new PodEvents();
  const events = eventsRef.current;

  useEffect(() => {
    recordWorkspace(route.id, route.isRef ? 'pod' : 'blank');
    // Hold a lifetime lock so the catalog's sweeper knows this tab is alive.
    try {
      void navigator.locks.request(wsLockName(route.id), { mode: 'shared' }, () => new Promise(() => {}));
    } catch {
      // no Web Locks — the sweeper is conservative without it
    }
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
      const blankRoot = `/work/${route.id}`;
      if (!route.isRef) await fs.promises.mkdir(blankRoot, { recursive: true }).catch(() => {});
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
          cwd: route.isRef ? undefined : blankRoot,
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
            ...(route.isRef ? { basis: { ref: route.id } } : {}),
          },
          // The demo reads transparently hydrate (sync plan D6); find/ls stay zero-fetch.
          hydration: {
            policy: { default: 'lazy' },
            onDemand: 'fetch',
            ...(route.isRef ? { defaultRef: route.id } : {}),
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
      setWorkspaceRoot(pod.basis ? pod.basis.at : blankRoot);
      setFsReady(true);
    })().catch((e) => console.error('Sandbox init failed:', e));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.id, route.isRef]);

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

  // ctrl+` slides the console up/down (the VS Code muscle memory)
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

  // Drag the console divider to resize.
  const onDividerPointerDown = useCallback((down: React.PointerEvent) => {
    down.preventDefault();
    const startY = down.clientY;
    setTermHeight((startHeight) => {
      const move = (e: PointerEvent) => {
        const next = Math.min(Math.max(startHeight + (startY - e.clientY), 120), window.innerHeight * 0.8);
        setTermHeight(next);
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

  const handleFileSelect = (path: string) => {
    setEditingFile(path);
    setActiveView('editor');
  };

  const handleCloseEditor = () => {
    setEditingFile(null);
    setActiveView('tree');
  };

  const tab = (view: ViewMode, icon: React.ReactNode, label: string, disabled = false) => (
    <button
      onClick={() => setActiveView(view)}
      disabled={disabled}
      className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
        activeView === view
          ? 'bg-[#1e1e1e] text-white border-t-2 border-blue-500'
          : disabled
            ? 'text-gray-600 cursor-not-allowed'
            : 'text-gray-400 hover:text-gray-200 hover:bg-[#3d3d3d]'
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <main className="flex h-[var(--app-height)] flex-col bg-black text-white overflow-hidden pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {/* Navigation: Home goes to /, tabs switch the workspace view */}
      <div className="flex items-center bg-[#2d2d2d] border-b border-gray-700 px-2">
        {/* full reload on purpose: leaving a workspace drops its FS/pod state */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/"
          className="flex items-center gap-2 px-3 py-3 text-sm font-medium text-gray-400 hover:text-gray-200 hover:bg-[#3d3d3d]"
          aria-label="All artipods"
        >
          <HomeIcon size={16} />
        </a>
        <span className="px-2 font-mono text-sm text-gray-300 truncate max-w-[14rem]" title={route.id}>
          {route.isRef ? route.id : `blank ${route.id}`}
        </span>
        {tab('tree', <FolderTree size={16} />, 'Files')}
        {tab('editor', <FileCode size={16} />, `Editor${editingFile ? ` (${editingFile.split('/').pop()})` : ''}`, !editingFile)}
        {tab('agent', <Bot size={16} />, 'Agent')}
        <div className="ml-auto flex items-center">
          <button
            onClick={() => setTermOpen((o) => !o)}
            className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors ${
              termOpen ? 'text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-[#3d3d3d]'
            }`}
            title="Toggle terminal (ctrl+`)"
          >
            <LucideTerminal size={16} />
            Terminal
            <kbd className="hidden sm:inline px-1 rounded bg-[#3d3d3d] border border-gray-600 text-[10px] font-mono">ctrl+`</kbd>
          </button>
          {tab('settings', <Settings size={16} />, `Storage${fsInfo ? ` (${fsInfo.backend})` : ''}`)}
        </div>
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
            Opening {route.isRef ? route.id : `blank workspace ${route.id}`}…
          </div>
        )}

        {/* Agent View - Always mounted to preserve chat state */}
        <div className={`absolute inset-0 ${activeView === 'agent' ? 'z-10' : 'z-0 invisible'}`}>
          {fsReady && (
            <AgentPanel
              getSandbox={() => sandboxRef.current}
              events={events}
              getLoopOptions={() => podRef.current?.agentLoopOptions() ?? {}}
            />
          )}
        </div>

        {/* File Tree - always mounted: fs:changed keeps it fresh across views */}
        <div className={`absolute inset-0 ${activeView === 'tree' ? 'z-10' : 'z-0 invisible'}`}>
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
            No file open. Select a file from Files or use the <code className="mx-1">edit</code> command.
          </div>
        )}

        {/* Storage Settings View */}
        {activeView === 'settings' && fsInfo && (
          <div className="absolute inset-0 z-10">
            <StorageSettings backend={fsInfo.backend} isPrimaryTab={fsInfo.isPrimaryTab} />
          </div>
        )}
      </div>

      {/* Console panel: slides up from the bottom, resizable, always mounted */}
      <div
        className="shrink-0 border-t border-gray-700 bg-[#1e1e1e] overflow-hidden"
        style={{ height: termOpen ? termHeight : 0 }}
      >
        <div
          onPointerDown={onDividerPointerDown}
          className="h-1.5 cursor-row-resize bg-[#2d2d2d] hover:bg-blue-500 transition-colors"
          title="Drag to resize"
        />
        <div style={{ height: termOpen ? termHeight - 6 : 0 }}>
          {fsReady && sandboxRef.current && (
            <Terminal
              sandbox={sandboxRef.current}
              events={events}
              readOnly={fsInfo ? !fsInfo.isPrimaryTab : false}
            />
          )}
        </div>
      </div>
    </main>
  );
}
