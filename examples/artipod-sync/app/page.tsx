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
import { Terminal as LucideTerminal, FolderTree, FileCode, Settings, Bot, Home as HomeIcon, Plus, Server, HardDrive, Layers as LayersIcon } from 'lucide-react';

// Dynamically import Terminal to avoid SSR issues with xterm.js
const Terminal = dynamicImport(() => import('@/components/Terminal'), {
  ssr: false,
});

export const dynamic = 'force-dynamic';

/**
 * Routing (?artipod=<ref-or-id>&mode=rw|cow|ro, static-export friendly):
 *   /                     → the catalog (server + local artipods, new blank)
 *   /?artipod=me/play:1   → workspace over that published pod (refs contain ':')
 *   /?artipod=71702f6e    → workspace over blank /work/71702f6e
 * Modes (server pods): rw = overlay auto-pushes (default); cow = overlay
 * stays local — the pod forks into an "on this machine" variant; ro = no
 * writes at all.
 */
type OpenMode = 'rw' | 'cow' | 'ro';

interface Route {
  id: string;
  isRef: boolean;
  mode: OpenMode;
}

const workspaceUrl = (id: string, mode: OpenMode = 'rw'): string =>
  `/?artipod=${encodeURIComponent(id)}${mode === 'rw' ? '' : `&mode=${mode}`}`;

/** Workspaces this browser has opened before (the "on this machine" list). */
interface LocalEntry {
  id: string;
  kind: 'pod' | 'blank';
  lastOpened: number;
  mode?: OpenMode;
  /** Maintained by the workspace: the overlay upper holds unpushed writes. */
  hasChanges?: boolean;
}

const REGISTRY_KEY = 'artipod-workspaces';

function readRegistry(): LocalEntry[] {
  try {
    return JSON.parse(localStorage.getItem(REGISTRY_KEY) ?? '[]') as LocalEntry[];
  } catch {
    return [];
  }
}

function recordWorkspace(id: string, kind: 'pod' | 'blank', mode: OpenMode): void {
  const prev = readRegistry().find((e) => e.id === id);
  const rest = readRegistry().filter((e) => e.id !== id);
  localStorage.setItem(
    REGISTRY_KEY,
    JSON.stringify([{ ...prev, id, kind, mode, lastOpened: Date.now() }, ...rest].slice(0, 50)),
  );
}

function patchRegistry(id: string, patch: Partial<LocalEntry>): void {
  const entries = readRegistry();
  const hit = entries.find((e) => e.id === id);
  if (!hit) return;
  Object.assign(hit, patch);
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(entries));
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
    const params = new URLSearchParams(window.location.search);
    const id = params.get('artipod');
    const modeParam = params.get('mode');
    const mode: OpenMode = modeParam === 'cow' || modeParam === 'ro' ? modeParam : 'rw';
    setRoute(id ? { id, isRef: id.includes(':'), mode } : null);
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
  // root console: the WHOLE browser fs (all of /work, /proc, pod internals)
  const [rootSandbox, setRootSandbox] = useState<Sandbox | null>(null);
  const [termOpen, setTermOpen] = useState(false);
  const [termHeight, setTermHeight] = useState(300);

  // Rescan "on this machine" — runs at load and after every console command.
  const refreshLocal = useCallback(async () => {
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
    } catch {
      // no /work yet (or init failed) — registry alone
    }
    // "local changes" = unpushed writes, tracked by the workspace tab (the
    // overlay upper is a mount only THAT page can see)
    setChangedRefs(new Set(registry.filter((e) => e.hasChanges).map((e) => e.id)));
    const byId = new Map<string, LocalEntry>(
      registry.filter((e) => !swept.includes(e.id) && (e.kind === 'pod' || onDisk.includes(e.id))).map((e) => [e.id, e]),
    );
    for (const id of onDisk) {
      if (!byId.has(id)) byId.set(id, { id, kind: 'blank', lastOpened: 0 });
    }
    setLocal(Array.from(byId.values()).sort((a, b) => b.lastOpened - a.lastOpened));
  }, []);

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
    let disposeEvents: (() => void) | null = null;
    (async () => {
      await refreshLocal();
      // the catalog's console is a root shell over the raw fs — /proc, every
      // /work workspace, and the pod internals are all inspectable here;
      // its commands rescan the lists (rm -rf /work/x updates the screen)
      try {
        const { fs } = await import('@/lib/filesystem');
        const { createSandbox } = await import('@artipod/core/sandbox');
        const { PodEvents: Events } = await import('@artipod/core/host');
        const consoleEvents = new Events();
        let timer: ReturnType<typeof setTimeout> | null = null;
        disposeEvents = consoleEvents.on('fs:changed', () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void refreshLocal(), 300);
        });
        setRootSandbox(createSandbox({ zfs: fs, cwd: '/', proc: true, events: consoleEvents }));
      } catch {
        // fs init failed — no console
      }
    })();
    return () => disposeEvents?.();
  }, [refreshLocal]);

  // ctrl+` opens the root console here too
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

  const localById = new Map(local.map((e) => [e.id, e]));
  // cow-opened pods with unpushed writes have FORKED — they belong to this machine
  const cowForks = local.filter((e) => e.kind === 'pod' && e.mode === 'cow' && changedRefs.has(e.id));
  const localOnly = [
    ...cowForks,
    ...local.filter((e) => !serverRefs?.includes(e.id) && !cowForks.includes(e)),
  ];

  const row = (id: string, badge: React.ReactNode, note: string, mode: OpenMode = 'rw') => (
    <li key={`${id}:${mode}`}>
      {/* full reload on purpose: a workspace boots its FS once per page */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href={workspaceUrl(id, mode)}
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

  /** rw / cow / ro choices per server pod — how the overlay behaves. */
  const modeLinks = (ref: string) => (
    <span className="flex items-center gap-1 font-mono">
      {(['rw', 'cow', 'ro'] as const).map((m) => (
        // eslint-disable-next-line @next/next/no-html-link-for-pages
        <a
          key={m}
          href={workspaceUrl(ref, m)}
          onClick={(e) => e.stopPropagation()}
          title={m === 'rw' ? 'writes auto-push to the server' : m === 'cow' ? 'writes stay on this machine (fork)' : 'read-only'}
          className="rounded border border-gray-600 px-1.5 py-0.5 text-[10px] uppercase text-gray-400 hover:text-white hover:border-gray-400"
        >
          {m}
        </a>
      ))}
    </span>
  );

  // Drag the console divider to resize.
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

  return (
    <main className="flex h-[var(--app-height)] flex-col bg-black text-white overflow-hidden">
      <div className="flex-1 overflow-auto">
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
              const isCowFork = cowForks.some((e) => e.id === ref);
              return row(
                ref,
                <>
                  {modeLinks(ref)}
                  {!isCowFork && changedRefs.has(ref) ? (
                    <span className="rounded bg-emerald-900/60 px-1.5 py-0.5">local changes</span>
                  ) : (
                    !isCowFork && opened && <span className="rounded bg-gray-700 px-1.5 py-0.5">synced</span>
                  )}
                  <span className="rounded bg-blue-900/60 px-1.5 py-0.5">server</span>
                </>,
                opened?.lastOpened && !isCowFork ? new Date(opened.lastOpened).toLocaleDateString() : '',
                opened?.mode === 'cow' || opened?.mode === 'ro' ? opened.mode : 'rw',
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
                <span className="rounded bg-emerald-900/60 px-1.5 py-0.5">
                  {e.kind === 'blank' ? 'blank' : e.mode === 'cow' ? 'cow fork' : 'local'}
                </span>,
                e.lastOpened ? new Date(e.lastOpened).toLocaleDateString() : '',
                e.mode ?? 'rw',
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

        <button
          onClick={() => setTermOpen((o) => !o)}
          disabled={!rootSandbox}
          className="mt-4 flex items-center justify-center gap-2 w-full px-3 py-2 rounded border border-gray-700 text-gray-400 hover:bg-[#222] text-sm disabled:opacity-40"
          title="Root console over the whole browser filesystem"
        >
          <LucideTerminal size={14} /> Root console — inspect /proc, /work, everything{' '}
          <kbd className="px-1 rounded bg-[#333] border border-gray-600 text-[10px] font-mono">ctrl+`</kbd>
        </button>
      </div>
      </div>

      {/* Root console: the unconfined shell — workspaces get a confined one */}
      <div className="shrink-0 border-t border-gray-700 bg-[#1e1e1e] overflow-hidden" style={{ height: termOpen ? termHeight : 0 }}>
        <div
          onPointerDown={onDividerPointerDown}
          className="h-1.5 cursor-row-resize bg-[#2d2d2d] hover:bg-blue-500 transition-colors"
          title="Drag to resize"
        />
        <div style={{ height: termOpen ? termHeight - 6 : 0 }}>
          {rootSandbox && <Terminal sandbox={rootSandbox} />}
        </div>
      </div>
    </main>
  );
}

type ViewMode = 'tree' | 'editor' | 'settings' | 'agent' | 'layers';

interface LayerRow {
  path: string;
  size: number;
  mtime?: string;
  digest: string;
}

/** The pod's stack: local upper (top) over the basis manifest's layers. */
function LayersView({ route, ready }: { route: Route; ready: boolean }) {
  const [layers, setLayers] = useState<LayerRow[] | null>(null);
  const [upperFiles, setUpperFiles] = useState<string[]>([]);
  const [head, setHead] = useState<{ digest: string; actor?: string; parents?: string } | null>(null);

  useEffect(() => {
    if (!ready) return;
    (async () => {
      const { fs } = await import('@/lib/filesystem');
      // the local upper is the writable top layer
      const upperDir = route.isRef ? `/.artipod/upper/${encodeURIComponent(route.id)}` : `/work/${route.id}`;
      const walk = async (dir: string, prefix = ''): Promise<string[]> => {
        const out: string[] = [];
        const entries = (await fs.promises.readdir(dir).catch(() => [])) as string[];
        for (const name of entries) {
          const full = `${dir}/${name}`;
          const stat = await fs.promises.stat(full).catch(() => null);
          if (stat?.isDirectory()) out.push(...(await walk(full, `${prefix}${name}/`)));
          else out.push(`${prefix}${name}`);
        }
        return out;
      };
      setUpperFiles(await walk(upperDir));

      if (!route.isRef) {
        setLayers([]);
        return;
      }
      try {
        const refRes = await fetch(`/api/pods/refs?name=${encodeURIComponent(route.id)}`);
        if (!refRes.ok) throw new Error(String(refRes.status));
        const { manifestDigest } = (await refRes.json()) as { manifestDigest: string };
        const manifest = (await (await fetch(`/api/pods/blobs/${manifestDigest}`)).json()) as {
          layers: { digest: string; size: number; annotations?: Record<string, string> }[];
          annotations?: Record<string, string>;
        };
        setHead({
          digest: manifestDigest,
          actor: manifest.annotations?.['org.artipod.actor'],
          parents: manifest.annotations?.['org.artipod.parents'],
        });
        setLayers(
          manifest.layers.map((l) => ({
            path: l.annotations?.['org.artipod.path'] ?? '(layer)',
            size: l.size,
            mtime: l.annotations?.['org.artipod.mtime'],
            digest: l.digest,
          })),
        );
      } catch {
        setLayers([]);
      }
    })();
  }, [route.id, route.isRef, ready]);

  const fmtSize = (n: number): string => (n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`);

  return (
    <div className="mx-auto max-w-2xl p-6 text-sm">
      <h2 className="font-semibold mb-1">Layers</h2>
      <p className="text-gray-400 mb-4">
        top wins on conflicts — the writable upper sits over the basis layers{route.mode === 'cow' ? ' (cow: the upper never pushes)' : route.mode === 'ro' ? ' (ro: the upper stays empty)' : ' (rw: the upper auto-pushes into a new head)'}
      </p>

      <div className="rounded border border-emerald-800 bg-emerald-950/40 px-3 py-2 mb-2">
        <div className="flex justify-between">
          <span className="font-mono">upper (this machine, writable)</span>
          <span className="text-gray-400">{upperFiles.length} file{upperFiles.length === 1 ? '' : 's'}</span>
        </div>
        {upperFiles.length > 0 && (
          <ul className="mt-1 text-gray-400 font-mono text-xs">
            {upperFiles.slice(0, 20).map((f) => (
              <li key={f}>/{f}</li>
            ))}
            {upperFiles.length > 20 && <li>… {upperFiles.length - 20} more</li>}
          </ul>
        )}
      </div>

      {route.isRef &&
        (layers === null ? (
          <p className="text-gray-500">loading basis manifest…</p>
        ) : (
          <>
            {head && (
              <p className="text-xs text-gray-500 mb-2 font-mono">
                head {head.digest.slice(7, 19)}…{head.actor ? ` · pushed by ${head.actor}` : ''}
                {head.parents ? ' · has parents (history reachable)' : ''}
              </p>
            )}
            <ul className="space-y-1">
              {layers.map((l) => (
                <li key={l.digest + l.path} className="rounded border border-gray-700 bg-[#252526] px-3 py-1.5 flex justify-between gap-3">
                  <span className="font-mono truncate">{l.path}</span>
                  <span className="shrink-0 text-xs text-gray-400">
                    {l.mtime ? `${new Date(l.mtime).toLocaleString()} · ` : ''}
                    {fmtSize(l.size)} · {l.digest.slice(7, 15)}…
                  </span>
                </li>
              ))}
            </ul>
          </>
        ))}
    </div>
  );
}

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
    recordWorkspace(route.id, route.isRef ? 'pod' : 'blank', route.mode);
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
      // cow forks must survive the tab: give the overlay upper its own
      // IndexedDB store instead of the default in-memory one
      const { IndexedDB } = await import('@zenfs/dom');
      const cowUpper = route.mode === 'cow' ? { backend: IndexedDB, storeName: `artipod-upper::${route.id}` } : undefined;
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
            ...(route.isRef
              ? { basis: { ref: route.id, upperConfig: cowUpper }, autoPush: route.mode === 'rw' }
              : {}),
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
      sandboxRef.current = pod.createSandbox({ confineTo: pod.basis ? pod.basis.at : blankRoot });
      podRef.current = pod;
      // demo/debug escape hatch (see docs/console.md's future replacement)
      (window as unknown as { __artipod?: unknown }).__artipod = pod;
      setWorkspaceRoot(pod.basis ? pod.basis.at : blankRoot);
      setFsReady(true);

      // Track unpushed work for the catalog: after each change (and each
      // successful push) probe the upper and persist the verdict.
      const upperAt = route.isRef ? `/.artipod/upper/${encodeURIComponent(route.id)}` : blankRoot;
      let probeTimer: ReturnType<typeof setTimeout> | null = null;
      const probe = () => {
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = setTimeout(() => {
          void (async () => {
            const entries = (await fs.promises.readdir(upperAt).catch(() => [])) as string[];
            patchRegistry(route.id, { hasChanges: entries.length > 0 });
          })();
        }, 500);
      };
      events.on('fs:changed', probe);
      events.on('sync:push', probe);
      probe();
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
          {route.mode !== 'rw' && (
            <span className="ml-1.5 rounded border border-gray-600 px-1 text-[10px] uppercase text-gray-400">{route.mode}</span>
          )}
        </span>
        {tab('tree', <FolderTree size={16} />, 'Files')}
        {tab('editor', <FileCode size={16} />, `Editor${editingFile ? ` (${editingFile.split('/').pop()})` : ''}`, !editingFile)}
        {tab('layers', <LayersIcon size={16} />, 'Layers')}
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
              readOnly={route.mode === 'ro' || (fsInfo ? !fsInfo.isPrimaryTab : false)}
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

        {/* Layers: the pod's stack — basis manifest layers + the local upper on top */}
        {activeView === 'layers' && (
          <div className="absolute inset-0 z-10 overflow-auto">
            <LayersView route={route} ready={fsReady} />
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
              readOnly={route.mode === 'ro' || (fsInfo ? !fsInfo.isPrimaryTab : false)}
            />
          )}
        </div>
      </div>
    </main>
  );
}
