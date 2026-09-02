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
import { Terminal as LucideTerminal, FolderTree, FileCode, Settings, Bot, Home as HomeIcon, Plus, Server, HardDrive, Layers as LayersIcon, UploadCloud } from 'lucide-react';

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
  /** ?publish=<name:tag> — publish right after the workspace boots (catalog one-step flow). */
  publishIntent?: string;
}

const workspaceUrl = (id: string, mode: OpenMode = 'rw'): string =>
  `/?artipod=${encodeURIComponent(id)}${mode === 'rw' ? '' : `&mode=${mode}`}`;

/** `_`-prefixed tags are open drafts; everything else seals on first push (serve default). */
const isOpenRef = (ref: string): boolean => ref.slice(ref.lastIndexOf(':') + 1).startsWith('_');
const setOpenTag = (ref: string, open: boolean): string => {
  const i = ref.lastIndexOf(':');
  if (i === -1) return ref;
  const tag = ref.slice(i + 1).replace(/^_+/, '');
  return `${ref.slice(0, i)}:${open ? '_' : ''}${tag}`;
};
const OPEN_DRAFT_TIP =
  'Checked: the tag starts with _ — an open draft anyone can keep editing (collaborative; can be renamed away later). Unchecked: the tag SEALS on publish — an immutable milestone that can never move or be deleted.';

/** Next free open tag for a fork of `ref`: me/play:1 → me/play:_2 (_3…), v2026-09-02 → _2026-09-02.2. */
const nextDraftRef = (ref: string, existing: Set<string>): string => {
  const i = ref.lastIndexOf(':');
  if (i === -1) return ref;
  const name = ref.slice(0, i);
  const tag = ref.slice(i + 1).replace(/^_+/, '');
  const numeric = /^\d+$/.test(tag);
  let n = numeric ? Number(tag) + 1 : 2;
  const make = () => (numeric ? `${name}:_${n}` : `${name}:_${tag}.${n}`);
  let candidate = make();
  while (existing.has(candidate)) {
    n += 1;
    candidate = make();
  }
  return candidate;
};

/** Workspaces this browser has opened before (the "on this machine" list). */
interface LocalEntry {
  id: string;
  kind: 'pod' | 'blank';
  lastOpened: number;
  mode?: OpenMode;
  /** Maintained by the workspace: the overlay upper holds unpushed writes. */
  hasChanges?: boolean;
}

/**
 * UI state (workspace registry + LWW actor id) lives IN the filesystem
 * (/.artipod/ui-state.json), not localStorage — on OPFS there is exactly one
 * home for artipod data, and wiping the fs wipes this too. A one-time
 * migration adopts the old localStorage keys, then deletes them.
 */
const STATE_FILE = '/.artipod/ui-state.json';
const LEGACY_REGISTRY_KEY = 'artipod-workspaces';
const LEGACY_ACTOR_KEY = 'artipod-actor';

interface UiState {
  actor?: string;
  workspaces: LocalEntry[];
}

async function uiFs() {
  await initFileSystem();
  const { fs } = await import('@/lib/filesystem');
  return fs;
}

/**
 * State IO goes through RAW OPFS handles when the app runs on OPFS: each
 * tab's ZenFS instance caches independently, so zenfs reads could be stale
 * and the cross-tab lock would serialize nothing. Raw handles always see
 * the latest bytes. Non-OPFS backends fall back to the (single-tab) zenfs.
 */
async function readStateText(): Promise<string | null> {
  const info = await initFileSystem();
  if (info?.backend === 'opfs') {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('artipod-fs')).getDirectoryHandle('.artipod');
      const file = await (await dir.getFileHandle('ui-state.json')).getFile();
      return await file.text();
    } catch {
      return null;
    }
  }
  const fs = await uiFs();
  return ((await fs.promises.readFile(STATE_FILE, 'utf8').catch(() => null)) as string | null) ?? null;
}

async function writeStateText(text: string): Promise<void> {
  const info = await initFileSystem();
  if (info?.backend === 'opfs') {
    const root = await navigator.storage.getDirectory();
    const fsDir = await root.getDirectoryHandle('artipod-fs', { create: true });
    const dir = await fsDir.getDirectoryHandle('.artipod', { create: true });
    const handle = await dir.getFileHandle('ui-state.json', { create: true });
    // Hard backstop under the Web Lock: an exclusive writable makes a racing
    // tab's write THROW (NoModificationAllowedError) instead of silently
    // clobbering. Older engines ignore/reject the option — retry plain.
    let w: FileSystemWritableFileStream;
    try {
      w = await (
        handle as { createWritable(o?: { mode?: string }): Promise<FileSystemWritableFileStream> }
      ).createWritable({ mode: 'exclusive' });
    } catch {
      w = await handle.createWritable();
    }
    await w.write(text);
    await w.close();
    return;
  }
  const fs = await uiFs();
  await fs.promises.mkdir('/.artipod', { recursive: true }).catch(() => {});
  await fs.promises.writeFile(STATE_FILE, text);
}

async function readState(): Promise<UiState> {
  const text = await readStateText();
  if (text !== null) {
    try {
      return JSON.parse(text) as UiState;
    } catch {
      return { workspaces: [] };
    }
  }
  // first boot: adopt any legacy localStorage state, then forget it
  const state: UiState = { workspaces: [] };
  try {
    state.workspaces = JSON.parse(localStorage.getItem(LEGACY_REGISTRY_KEY) ?? '[]') as LocalEntry[];
    state.actor = localStorage.getItem(LEGACY_ACTOR_KEY) ?? undefined;
    localStorage.removeItem(LEGACY_REGISTRY_KEY);
    localStorage.removeItem(LEGACY_ACTOR_KEY);
  } catch {
    // no localStorage — fresh state
  }
  return state;
}

async function writeState(state: UiState): Promise<void> {
  await writeStateText(JSON.stringify(state, null, 2));
}

/**
 * ui-state mutations are read-modify-write on one file; two tabs racing
 * would drop each other's updates. A Web Lock serializes them per origin
 * (no Web Locks → run unserialized, same as before).
 */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await navigator.locks.request('artipod-ui-state', fn);
  } catch {
    return fn();
  }
}

async function readRegistry(): Promise<LocalEntry[]> {
  return (await readState()).workspaces;
}

/** Stable per-profile LWW identity (Decision D8), minted on first use. */
async function actorId(): Promise<string> {
  return withStateLock(async () => {
    const state = await readState();
    if (!state.actor) {
      state.actor = `browser:${crypto.randomUUID().slice(0, 8)}`;
      await writeState(state);
    }
    return state.actor;
  });
}

async function recordWorkspace(id: string, kind: 'pod' | 'blank', mode: OpenMode): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    const prev = state.workspaces.find((e) => e.id === id);
    state.workspaces = [
      { ...prev, id, kind, mode, lastOpened: Date.now() },
      ...state.workspaces.filter((e) => e.id !== id),
    ].slice(0, 50);
    await writeState(state);
  });
}

async function patchRegistry(id: string, patch: Partial<LocalEntry>): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    const hit = state.workspaces.find((e) => e.id === id);
    if (!hit) return;
    Object.assign(hit, patch);
    await writeState(state);
  });
}

async function dropFromRegistry(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await withStateLock(async () => {
    const state = await readState();
    state.workspaces = state.workspaces.filter((e) => !ids.includes(e.id));
    await writeState(state);
  });
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
    setRoute(id ? { id, isRef: id.includes(':'), mode, publishIntent: params.get('publish') ?? undefined } : null);
  }, []);

  if (route === undefined) return <main className="h-[var(--app-height)] bg-black" />;
  if (route === null) return <Catalog />;
  return <Workspace route={route} />;
}

/** `/` — every artipod in reach: this server's, this machine's, or a new blank one. */
function Catalog() {
  const [serverRefs, setServerRefs] = useState<{ ref: string; manifestDigest?: string; locked?: boolean; pulledAt?: string }[] | null>(null);
  const [local, setLocal] = useState<LocalEntry[]>([]);
  // refs with actual local changes: a non-empty overlay upper (/.artipod/upper/<ref>)
  const [changedRefs, setChangedRefs] = useState<Set<string>>(new Set());
  // root console: the WHOLE browser fs (all of /work, /proc, pod internals)
  const [rootSandbox, setRootSandbox] = useState<Sandbox | null>(null);
  const [termOpen, setTermOpen] = useState(false);
  const [termHeight, setTermHeight] = useState(300);
  // repos whose older tags are expanded in the server list
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  // inline publish editor for a local row (native prompt is suppressed in driven browsers)
  const [pub, setPub] = useState<{ id: string; mode: OpenMode; value: string } | null>(null);

  // Rescan "on this machine" — runs at load and after every console command.
  const refreshLocal = useCallback(async () => {
    const registry = await readRegistry();
    const onDisk: string[] = [];
    const swept: string[] = [];
    let changed = new Set(registry.filter((e) => e.hasChanges).map((e) => e.id));
    try {
      const info = await initFileSystem();
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
      await dropFromRegistry(swept);
      // Published-blank reconciliation: content addressing means "is this
      // already on the server?" is a pure comparison — a blank whose file set
      // (path + mtime, round-tripped in the layer annotations) matches a
      // server ref's manifest IS that ref. Retire the anonymous copy.
      try {
        const serverList = (await (await fetch('/api/pods/refs')).json()) as { ref: string; manifestDigest: string }[];
        const manifests = await Promise.all(
          serverList.map(async ({ manifestDigest }) => {
            const m = (await (await fetch(`/api/pods/blobs/${manifestDigest}`)).json()) as {
              layers?: { annotations?: Record<string, string> }[];
            };
            const files = new Map<string, number>();
            for (const l of m.layers ?? []) {
              const p = l.annotations?.['org.artipod.path'];
              const t = l.annotations?.['org.artipod.mtime'];
              // the mtime annotation is raw epoch millis (ISO tolerated just in case)
              if (p && !p.startsWith('/.wh')) files.set(p, Number(t) || Date.parse(t ?? '') || 0);
            }
            return files;
          }),
        );
        const live = await liveWorkspaceIds();
        for (const id of [...onDisk]) {
          if (id.includes(':') || live.has(id)) continue; // refs and open tabs are not candidates
          const walk = async (dir: string, rel: string, out: Map<string, number>): Promise<void> => {
            for (const name of (await fs.promises.readdir(dir).catch(() => [])) as string[]) {
              const full = `${dir}/${name}`;
              const stat = await fs.promises.stat(full).catch(() => null);
              if (!stat) continue;
              if (stat.isDirectory()) await walk(full, `${rel}/${name}`, out);
              else out.set(`${rel}/${name}`, Number(stat.mtimeMs));
            }
          };
          const local = new Map<string, number>();
          await walk(`/work/${id}`, '', local);
          if (local.size === 0) continue;
          // tar mtimes are second-granular — compare with 2s tolerance
          const matches = manifests.some(
            (files) =>
              files.size === local.size &&
              Array.from(local.entries()).every(([p, t]) => files.has(p) && Math.abs((files.get(p) ?? 0) - t) < 2000),
          );
          if (matches) {
            await fs.promises.rm(`/work/${id}`, { recursive: true }).catch(() => {});
            swept.push(id);
            onDisk.splice(onDisk.indexOf(id), 1);
          }
        }
        await dropFromRegistry(swept);
      } catch {
        // offline or no server — reconciliation is best-effort
      }
      // On OPFS the physical cow uppers (.artipod/uppers/<enc>) are REAL dirs
      // the catalog can read — the filesystem is the source of truth, and the
      // registry is just a cache (rm -rf / must empty the screen). On the
      // IndexedDB fallback the uppers are invisible here, so trust the flags.
      if (info?.backend === 'opfs') {
        changed = new Set<string>();
        const modeById = new Map(registry.map((e) => [e.id, e.mode]));
        const uppers = (await fs.promises.readdir('/.artipod/uppers').catch(() => [])) as string[];
        for (const name of uppers) {
          const entries = (await fs.promises.readdir(`/.artipod/uppers/${name}`).catch(() => [])) as string[];
          const id = decodeURIComponent(name);
          // rw uppers persist too now, but autoPush keeps them synced — only
          // cow uppers represent unpushed divergence
          if (entries.length > 0 && modeById.get(id) !== 'rw') changed.add(id);
        }
        for (const e of registry) {
          if (e.hasChanges && !changed.has(e.id)) await patchRegistry(e.id, { hasChanges: false });
        }
      }
    } catch {
      // no /work yet (or init failed) — registry alone
    }
    setChangedRefs(changed);
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
        setServerRefs(res.ok ? ((await res.json()) as { ref: string; manifestDigest?: string; locked?: boolean; pulledAt?: string }[]) : []);
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
      // its commands rescan the lists (fs:changed after every exec)
      try {
        const { fs } = await import('@/lib/filesystem');
        const { createSandbox } = await import('@artipod/core/sandbox');
        const { PodEvents: Events } = await import('@artipod/core/host');
        const { defineCommand } = await import('just-bash/browser');
        // The safe alternative to rm -rf: erases ONLY artipod state (the OPFS
        // sandbox dir, artipod IndexedDB stores, the workspace registry) and
        // reloads into a factory-fresh machine. Server pods are untouched.
        const factoryReset = defineCommand('factory-reset', async (args: string[]) => {
          if (!args.includes('-f')) {
            return {
              stdout: '',
              stderr:
                'factory-reset erases ALL local artipod data in this browser:\n' +
                '  - the OPFS filesystem (workspaces, cow forks, pod store)\n' +
                '  - artipod IndexedDB stores\n' +
                '  - the workspace registry\n' +
                'Server pods are untouched. Run `factory-reset -f` to confirm.\n',
              exitCode: 1,
            };
          }
          try {
            const opfsRoot = await navigator.storage.getDirectory();
            await opfsRoot.removeEntry('artipod-fs', { recursive: true }).catch(() => {});
            for (const db of await indexedDB.databases()) {
              if (db.name && (db.name.startsWith('artipod') || db.name === 'browser-git-fs')) {
                await new Promise((r) => {
                  const req = indexedDB.deleteDatabase(db.name!);
                  req.onsuccess = req.onerror = req.onblocked = r;
                });
              }
            }
            localStorage.removeItem(LEGACY_REGISTRY_KEY);
            localStorage.removeItem(LEGACY_ACTOR_KEY);
          } finally {
            setTimeout(() => window.location.reload(), 500);
          }
          return { stdout: 'local artipod data erased — reloading a factory-fresh machine…\n', stderr: '', exitCode: 0 };
        });
        const consoleEvents = new Events();
        let timer: ReturnType<typeof setTimeout> | null = null;
        disposeEvents = consoleEvents.on('fs:changed', () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void refreshLocal(), 300);
        });
        setRootSandbox(
          createSandbox({ zfs: fs, cwd: '/', proc: true, events: consoleEvents, extraCommands: [factoryReset] }),
        );
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
    ...local.filter((e) => !serverRefs?.some((r) => r.ref === e.id) && !cowForks.includes(e)),
  ];

  const row = (id: string, badge: React.ReactNode, note: string, mode: OpenMode = 'rw', label?: string) => (
    <li key={`${id}:${mode}`}>
      {/* full reload on purpose: a workspace boots its FS once per page */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href={workspaceUrl(id, mode)}
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 rounded bg-[#333] hover:bg-[#3d3d3d] text-sm"
      >
        {/* the name always wins the width fight — badges wrap to a second line on phones */}
        <span className="font-mono truncate min-w-0 flex-1 basis-40">{label ?? id}</span>
        <span className="flex flex-wrap items-center justify-end gap-2 text-xs text-gray-400">
          {note && <span className="hidden sm:inline">{note}</span>}
          {badge}
        </span>
      </a>
    </li>
  );

  /** rw / cow / ro choices per server pod — a locked tag cannot take pushes, so rw is gone. */
  const modeLinks = (ref: string, locked?: boolean) => (
    <span className="flex items-center gap-1 font-mono">
      {(locked ? (['cow', 'ro'] as const) : (['rw', 'cow', 'ro'] as const)).map((m) => (
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
            {/* one row per repository: unique tag = a plain row; multiple tags =
                the latest (drafts first, then newest milestone) + an expander */}
            {Array.from(
              serverRefs.reduce((groups, r) => {
                const i = r.ref.lastIndexOf(':');
                const name = i === -1 ? r.ref : r.ref.slice(0, i);
                (groups.get(name) ?? groups.set(name, []).get(name)!).push(r);
                return groups;
              }, new Map<string, typeof serverRefs>()),
            )
              .sort(([, refsA], [, refsB]) => {
                // most recently pushed repo on top
                const t = (rs: typeof refsA) => Math.max(...rs.map((r) => Date.parse(r.pulledAt ?? '') || 0));
                return t(refsB) - t(refsA);
              })
              .map(([name, refs]) => {
                const sorted = refs.slice().sort((a, b) => {
                  const ta = a.ref.slice(a.ref.lastIndexOf(':') + 1);
                  const tb = b.ref.slice(b.ref.lastIndexOf(':') + 1);
                  const oa = ta.startsWith('_') ? 0 : 1;
                  const ob = tb.startsWith('_') ? 0 : 1;
                  return oa - ob || tb.localeCompare(ta); // drafts first, then newest milestone
                });
                const renderRef = ({ ref, manifestDigest, locked }: (typeof serverRefs)[number], label?: string, extra?: React.ReactNode) => {
                  const opened = localById.get(ref);
                  const isCowFork = cowForks.some((e) => e.id === ref);
                  return row(
                    ref,
                    <>
                      {manifestDigest && (
                        // the tag is a mutable pointer — the digest shows WHERE it points, so movement is visible
                        <span className="font-mono text-gray-500" title={manifestDigest}>
                          @{manifestDigest.replace(/^sha256:/, '').slice(0, 8)}
                        </span>
                      )}
                      {locked && (
                        <span className="rounded bg-amber-900/60 px-1.5 py-0.5" title="tag is locked — the head cannot move; fork with cow and publish under a new name">
                          locked
                        </span>
                      )}
                      {isCowFork && (
                        <span
                          className="rounded bg-emerald-900/60 px-1.5 py-0.5"
                          title="this machine holds a diverged fork of this ref — see it under 'On this machine'"
                        >
                          forked
                        </span>
                      )}
                      {modeLinks(ref, locked)}
                      {!isCowFork && changedRefs.has(ref) ? (
                        <span className="rounded bg-emerald-900/60 px-1.5 py-0.5">local changes</span>
                      ) : (
                        !isCowFork && opened && <span className="rounded bg-gray-700 px-1.5 py-0.5">synced</span>
                      )}
                      {extra}
                    </>,
                    opened?.lastOpened && !isCowFork ? new Date(opened.lastOpened).toLocaleDateString() : '',
                    locked ? (opened?.mode === 'ro' ? 'ro' : 'cow') : opened?.mode === 'cow' || opened?.mode === 'ro' ? opened.mode : 'rw',
                    label,
                  );
                };
                const [latest, ...older] = sorted;
                const isOpen = expandedRepos.has(name);
                return (
                  <li key={name} className="space-y-1">
                    <ul className="space-y-1">
                      {renderRef(
                        latest,
                        undefined,
                        older.length > 0 ? (
                          <button
                            onClick={(ev) => {
                              ev.preventDefault();
                              ev.stopPropagation();
                              setExpandedRepos((prev) => {
                                const next = new Set(prev);
                                if (next.has(name)) next.delete(name);
                                else next.add(name);
                                return next;
                              });
                            }}
                            className="rounded border border-gray-600 px-1.5 py-0.5 text-[10px] text-gray-400 hover:text-white hover:border-gray-400"
                            title={`${older.length} older tag${older.length === 1 ? '' : 's'} in ${name}`}
                          >
                            {isOpen ? '▾' : '▸'} +{older.length}
                          </button>
                        ) : undefined,
                      )}
                      {isOpen && (
                        <ul className="space-y-1 pl-4 border-l border-gray-700 ml-2">
                          {older.map((r) => renderRef(r, `:${r.ref.slice(r.ref.lastIndexOf(':') + 1)}`))}
                        </ul>
                      )}
                    </ul>
                  </li>
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
            {localOnly.map((e) => {
              // a cow fork IS a pending draft — show it under the _ name it
              // will publish as, not the pristine tag it diverged from
              const draftName =
                e.kind === 'pod' && e.mode === 'cow'
                  ? nextDraftRef(e.id, new Set((serverRefs ?? []).map((r) => r.ref)))
                  : null;
              return row(
                e.id,
                <>
                  <button
                    onClick={(ev) => {
                      ev.preventDefault();
                      ev.stopPropagation();
                      setPub({
                        id: e.id,
                        mode: e.mode ?? 'rw',
                        value: e.kind === 'blank' ? `me/${e.id}:_1` : (draftName ?? e.id),
                      });
                    }}
                    className="rounded border border-gray-600 px-1.5 py-0.5 text-[10px] uppercase text-gray-400 hover:text-white hover:border-gray-400"
                    title="Publish to the server"
                  >
                    publish
                  </button>
                  <span className="rounded bg-emerald-900/60 px-1.5 py-0.5">
                    {e.kind === 'blank' ? 'blank' : e.mode === 'cow' ? 'unpublished fork' : 'local'}
                  </span>
                </>,
                draftName ? `fork of ${e.id}` : e.lastOpened ? new Date(e.lastOpened).toLocaleDateString() : '',
                e.mode ?? 'rw',
                draftName ?? e.id,
              );
            })}
          </ul>
        )}

        {/* inline publish editor — the workspace boots its own pod, publish runs there via ?publish= */}
        {pub && (
          <div className="flex flex-wrap items-center gap-2 mb-6">
            {/* the label takes its own line on phones so the input row fits */}
            <span className="text-xs text-gray-400 font-mono basis-full sm:basis-auto sm:shrink-0">publish {pub.id} as</span>
            <input
              autoFocus
              value={pub.value}
              onChange={(e) => setPub({ ...pub, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setPub(null);
                if (e.key === 'Enter' && pub.value.trim()) {
                  window.location.href = `${workspaceUrl(pub.id, pub.mode)}&publish=${encodeURIComponent(pub.value.trim())}`;
                }
              }}
              className="flex-1 min-w-0 px-2 py-1 rounded border border-gray-600 bg-transparent text-sm font-mono text-gray-200"
            />
            <label className="flex items-center gap-1.5 text-xs text-gray-300 shrink-0 cursor-pointer" title={OPEN_DRAFT_TIP}>
              <input
                type="checkbox"
                checked={isOpenRef(pub.value)}
                onChange={(e) => setPub({ ...pub, value: setOpenTag(pub.value, e.target.checked) })}
              />
              open draft
            </label>
            <button
              onClick={() => {
                if (pub.value.trim())
                  window.location.href = `${workspaceUrl(pub.id, pub.mode)}&publish=${encodeURIComponent(pub.value.trim())}`;
              }}
              className="px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 text-sm"
            >
              Publish
            </button>
            <button onClick={() => setPub(null)} className="px-2 py-1 text-gray-400 hover:text-white text-sm">
              ✕
            </button>
          </div>
        )}

        <NewWorkspace />

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

/** New workspace: blank, or named-and-published in a single step (?publish= intent). */
function NewWorkspace() {
  const [name, setName] = useState('');
  const [openDraft, setOpenDraft] = useState(true);
  const go = () => {
    const id = crypto.randomUUID().slice(0, 8);
    const target = name.trim();
    if (!target) return void (window.location.href = workspaceUrl(id));
    const ref = setOpenTag(target.includes(':') ? target : `${target}:1`, openDraft);
    window.location.href = `${workspaceUrl(id)}&publish=${encodeURIComponent(ref)}`;
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()}
        placeholder="name (optional — publishes right away)"
        className="flex-1 min-w-0 px-3 py-2 rounded border border-gray-600 bg-transparent text-sm text-gray-200 placeholder-gray-500 font-mono"
      />
      {name.trim() && (
        <label className="flex items-center gap-1.5 text-xs text-gray-300 shrink-0 cursor-pointer" title={OPEN_DRAFT_TIP}>
          <input type="checkbox" checked={openDraft} onChange={(e) => setOpenDraft(e.target.checked)} />
          open draft
        </label>
      )}
      <button
        onClick={go}
        className="flex items-center justify-center gap-2 px-3 py-2 rounded border border-gray-600 text-gray-300 hover:bg-[#333] text-sm shrink-0"
      >
        <Plus size={14} /> {name.trim() ? 'Create & publish' : 'New blank workspace'}
      </button>
    </div>
  );
}

interface LayerRow {
  path: string;
  size: number;
  mtime?: string;
  digest: string;
}

/** The pod's stack: local upper (top) over the basis manifest's layers. */
function LayersView({ route, ready, onPublish, onBack }: { route: Route; ready: boolean; onPublish?: () => void; onBack?: () => void }) {
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
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold">Layers</h2>
        <div className="flex items-center gap-2">
          {onPublish && (
            <button onClick={onPublish} className="text-xs bg-blue-800 px-2 py-1 rounded hover:bg-blue-700">
              Publish
            </button>
          )}
          {onBack && (
            <button onClick={onBack} className="text-xs bg-gray-700 px-2 py-1 rounded hover:bg-gray-600">
              ← Files
            </button>
          )}
        </div>
      </div>
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
                    {/* org.artipod.mtime is raw epoch millis (ISO tolerated) */}
                    {l.mtime ? `${new Date(Number(l.mtime) || l.mtime).toLocaleString()} · ` : ''}
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
  // publish action shared by the shell verb, the nav button, and ?publish= intents
  const doPublishRef = useRef<((target?: string) => Promise<string>) | null>(null);
  const [publishing, setPublishing] = useState(false);
  // inline publish panel (window.prompt/alert are suppressed in driven browsers)
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishValue, setPublishValue] = useState('');
  const [publishNotice, setPublishNotice] = useState<string | null>(null);
  // One event bus per pod: terminal, tree, editor and agent stay coherent.
  const eventsRef = useRef<PodEvents | null>(null);
  if (!eventsRef.current) eventsRef.current = new PodEvents();
  const events = eventsRef.current;

  useEffect(() => {
    // Hold a lifetime lock so the catalog's sweeper knows this tab is alive.
    try {
      void navigator.locks.request(wsLockName(route.id), { mode: 'shared' }, () => new Promise(() => {}));
    } catch {
      // no Web Locks — the sweeper is conservative without it
    }
    let cancelled = false;
    (async () => {
      const info = await initFileSystem();
      await recordWorkspace(route.id, route.isRef ? 'pod' : 'blank', route.mode);
      const actor = await actorId();
      // just-bash + the pod layer load lazily so they stay out of the first-load bundle
      const [{ createZenFsPod }, { ArtipodRegistryProxyTransport }, { HttpPodStore }, { fs }] = await Promise.all([
        import('@artipod/core'),
        import('@artipod/core/oci'),
        import('@artipod/core/manager'),
        import('@/lib/filesystem'),
      ]);
      if (cancelled) return;
      setFsInfo(info);
      // Writable workspaces (rw AND cow) get a persistent upper keyed by ref
      // — one local working state per ref; the mode only chooses whether it
      // auto-pushes. An in-memory rw upper would start every session empty,
      // and its first push would strip the previous session's overlay layers.
      const { mountConfigForSpec } = await import('@artipod/core/sandbox');
      const cowUpper =
        route.isRef && route.mode !== 'ro'
          ? await mountConfigForSpec(
              info?.backend === 'opfs'
                ? { type: 'opfs', dir: `.artipod/uppers/${encodeURIComponent(route.id)}` }
                : { type: 'indexeddb', store: `artipod-upper::${encodeURIComponent(route.id)}` },
            )
          : undefined;
      // Each blank workspace gets its own fresh root; a basis brings its own.
      const blankRoot = `/work/${route.id}`;
      if (!route.isRef) await fs.promises.mkdir(blankRoot, { recursive: true }).catch(() => {});
      // PAT prompt for git push/fetch to private repos (token kept off the sandbox fs)
      const { setAuthPrompt } = await import('@/lib/git-auth');
      setAuthPrompt(async (origin) =>
        window.prompt(`Personal access token for ${origin} (stored in memory):`),
      );
      const remote = new HttpPodStore('/api/pods');
      // publish [<name:tag>] — the workspace's door to the server (docs/sync.md):
      //   cow fork,  no arg  → push back: the fork's changes advance its own ref
      //   any ws,   <ref>    → publish-as: this workspace becomes a NEW server ref
      //   blank              → <ref> required (an anonymous scratch dir has no name to push to)
      // Canonical verb: `artipod publish` (core); `publish` and the UI button alias it.
      const doPublish = async (target?: string): Promise<string> => {
        const pod = podRef.current;
        if (!pod) throw new Error('workspace still opening — try again');
        if (route.mode === 'ro') throw new Error('read-only workspace');
        const { pushOverlay } = await import('@artipod/core/manager');
        const { sha256 } = await import('@artipod/core/oci');
        const store = pod.oci.store;
        const MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';
        const enc = new TextEncoder();
        if (!target || target === route.id) {
          if (!route.isRef) throw new Error('a blank workspace needs a name — publish <name:tag>, e.g. publish me/scratch:_1 (_-tags stay open; others seal on first push)');
          // push back — pushOverlay directly (not pod.pushBasis) so a server
          // refusal (e.g. a sealed tag) surfaces here instead of a console warning
          const result = await pushOverlay({
            store,
            zfs: pod.zfs,
            ref: route.id,
            upperAt: `/.artipod/upper/${encodeURIComponent(route.id)}`,
            deletions: pod.hydrator?.overlayDeletions(route.id) ?? new Map(),
            actor,
            remote,
          });
          if (!result.pushed) return `nothing to push for ${route.id}`;
          await patchRegistry(route.id, { hasChanges: false });
          return `pushed ${route.id}: ${result.overlayLayers} overlay layer(s) → ${result.manifestDigest.slice(0, 19)}…`;
        }
        if (!target.includes(':')) throw new Error(`include a tag — e.g. publish ${target}:_1 (_ = open; without _ it seals on first push)`);
        let upperAt: string;
        let deletions = new Map<string, number>();
        if (route.isRef) {
          // publish-as: new ref = basis layers + this fork's upper; the source tag never moves
          const basisHead = await store.getRef(route.id);
          if (!basisHead) throw new Error(`no local head for ${route.id}`);
          await store.putRef(target, basisHead.manifestDigest, MANIFEST_TYPE);
          upperAt = `/.artipod/upper/${encodeURIComponent(route.id)}`;
          deletions = pod.hydrator?.overlayDeletions(route.id) ?? deletions;
        } else {
          // blank: seed an empty head, then the whole workspace is the overlay
          const config = enc.encode(JSON.stringify({ artipod: { formatVersion: 1 }, rootfs: { type: 'layers', diff_ids: [] } }));
          const configDigest = await sha256(config);
          await store.putBlob(config, configDigest);
          const manifest = {
            schemaVersion: 2,
            mediaType: MANIFEST_TYPE,
            config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: config.length },
            layers: [],
          };
          const manifestBytes = enc.encode(JSON.stringify(manifest));
          const manifestDigest = await sha256(manifestBytes);
          await store.putBlob(manifestBytes, manifestDigest);
          await store.putRef(target, manifestDigest, MANIFEST_TYPE);
          upperAt = blankRoot;
        }
        // permanent: the upper is retired below — replaceable overlay layers
        // would be STRIPPED by the next (even empty) push from this actor
        const result = await pushOverlay({ store, zfs: pod.zfs, ref: target, upperAt, deletions, actor, remote, permanent: true });
        if (route.isRef && route.mode === 'cow') {
          // a cow fork migrates: its changes live under the new name now.
          // NEVER empty an rw upper — it mirrors overlay layers already on
          // the ref's head, and draining it invites the next push to drop them.
          for (const name of (await fs.promises.readdir(upperAt).catch(() => [])) as string[]) {
            await fs.promises.rm(`${upperAt}/${name}`, { recursive: true }).catch(() => {});
          }
          deletions.clear();
          await patchRegistry(route.id, { hasChanges: false });
        } else {
          // the blank workspace IS the ref now — retire the anonymous copy so
          // the catalog shows one home: on the server, open to collaborate
          await fs.promises.rm(blankRoot, { recursive: true }).catch(() => {});
          await dropFromRegistry([route.id]);
        }
        setTimeout(() => {
          window.location.href = workspaceUrl(target, 'rw');
        }, 800);
        return `published ${target} (${result.overlayLayers} layer(s) over ${route.isRef ? `${route.id}'s basis` : 'an empty basis'}) — opening it read-write…`;
      };
      doPublishRef.current = doPublish;
      const { defineCommand } = await import('just-bash/browser');
      const publishCmd = defineCommand('publish', async (cmdArgs) => {
        try {
          return { stdout: `${await doPublish(cmdArgs[0])}\n`, stderr: '', exitCode: 0 };
        } catch (e) {
          return { stdout: '', stderr: `publish: ${(e as Error).message}\n`, exitCode: 1 };
        }
      });
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
            remote,
            actor,
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
          publish: doPublish,
          extraCommands: [publishCmd],
        },
      );
      sandboxRef.current = pod.createSandbox({ confineTo: pod.basis ? pod.basis.at : blankRoot });
      podRef.current = pod;
      // demo/debug escape hatch (see docs/console.md's future replacement)
      (window as unknown as { __artipod?: unknown }).__artipod = pod;
      setWorkspaceRoot(pod.basis ? pod.basis.at : blankRoot);
      setFsReady(true);

      // Catalog one-step flow: /?artipod=<id>&publish=<name:tag>
      if (route.publishIntent) {
        window.history.replaceState(null, '', workspaceUrl(route.id, route.mode));
        try {
          setPublishNotice(await doPublish(route.publishIntent));
        } catch (e) {
          setPublishNotice(`publish ${route.publishIntent}: ${(e as Error).message}`);
        }
      }

      // Track unpushed work for the catalog: after each change (and each
      // successful push) probe the upper and persist the verdict.
      const upperAt = route.isRef ? `/.artipod/upper/${encodeURIComponent(route.id)}` : blankRoot;
      let probeTimer: ReturnType<typeof setTimeout> | null = null;
      const probe = () => {
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = setTimeout(() => {
            void (async () => {
              const entries = (await fs.promises.readdir(upperAt).catch(() => [])) as string[];
              await patchRegistry(route.id, { hasChanges: entries.length > 0 });
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

  const openPublish = () => {
    // suggest an OPEN (_) tag — the server seals everything else on first push
    setPublishValue(route.isRef ? route.id : `me/${route.id}:_1`);
    setPublishNotice(null);
    setPublishOpen(true);
    // a fork is a pending draft: suggest its next free _ tag (push back to an
    // unlocked origin stays one edit away — the ref itself)
    if (route.isRef && route.mode === 'cow') {
      void (async () => {
        try {
          const refs = (await (await fetch('/api/pods/refs')).json()) as { ref: string; locked?: boolean }[];
          setPublishValue(nextDraftRef(route.id, new Set(refs.map((r) => r.ref))));
        } catch {
          // offline — keep the plain suggestion
        }
      })();
    }
  };

  const submitPublish = () => {
    void (async () => {
      const doPublish = doPublishRef.current;
      const target = publishValue.trim();
      if (!doPublish || publishing || !target) return;
      setPublishing(true);
      setPublishNotice(null);
      try {
        setPublishNotice(await doPublish(target));
      } catch (e) {
        setPublishNotice(`publish: ${(e as Error).message}`);
      } finally {
        setPublishing(false);
      }
    })();
  };

  const tab = (view: ViewMode, icon: React.ReactNode, label: string, disabled = false) => (
    <button
      onClick={() => setActiveView(view)}
      disabled={disabled}
      title={label}
      className={`flex items-center gap-2 px-2.5 sm:px-4 py-3 text-sm font-medium transition-colors shrink-0 ${
        activeView === view
          ? 'bg-[#1e1e1e] text-white border-t-2 border-blue-500'
          : disabled
            ? 'text-gray-600 cursor-not-allowed'
            : 'text-gray-400 hover:text-gray-200 hover:bg-[#3d3d3d]'
      }`}
    >
      {icon}
      {/* icons carry the tab on phones — labels return at sm */}
      <span className="hidden sm:inline">{label}</span>
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
        <span className="px-2 font-mono text-sm text-gray-300 truncate min-w-0 max-w-[7rem] sm:max-w-[14rem]" title={route.id}>
          {route.isRef ? (route.mode === 'cow' ? `fork of ${route.id}` : route.id) : `blank ${route.id}`}
          {route.mode !== 'rw' && (
            <span className="ml-1.5 rounded border border-gray-600 px-1 text-[10px] uppercase text-gray-400">{route.mode}</span>
          )}
        </span>
        {tab('tree', <FolderTree size={16} />, 'Files')}
        {tab('editor', <FileCode size={16} />, `Editor${editingFile ? ` (${editingFile.split('/').pop()})` : ''}`, !editingFile)}
        {tab('agent', <Bot size={16} />, 'Agent')}
        <div className="ml-auto flex items-center">
          <button
            onClick={() => setTermOpen((o) => !o)}
            title="Toggle terminal (ctrl+`)"
            className={`flex items-center gap-2 px-2.5 sm:px-4 py-3 text-sm font-medium transition-colors shrink-0 ${
              termOpen ? 'text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-[#3d3d3d]'
            }`}
          >
            <LucideTerminal size={16} />
            <span className="hidden sm:inline">Terminal</span>
            <kbd className="hidden md:inline px-1 rounded bg-[#3d3d3d] border border-gray-600 text-[10px] font-mono">ctrl+`</kbd>
          </button>
          {tab('settings', <Settings size={16} />, `Storage${fsInfo ? ` (${fsInfo.backend})` : ''}`)}
        </div>
      </div>

      {fsInfo && !fsInfo.isPrimaryTab && (
        <div role="alert" className="bg-yellow-900 text-yellow-100 text-sm px-4 py-2">
          Filesystem already open in another tab — tabs don&apos;t share changes and the last write wins. Use one tab at a time.
        </div>
      )}

      {/* Inline publish panel (native prompt/alert are suppressed in driven browsers) */}
      {publishOpen && (
        <div className="flex flex-wrap items-center gap-2 bg-[#252526] border-b border-gray-700 px-4 py-2">
          {/* label takes its own line on phones so the input row fits */}
          <span className="text-xs text-gray-400 basis-full sm:basis-auto sm:shrink-0">
            {route.isRef ? `publish — keep “${route.id}” to push back, or a new name:tag to branch:` : 'publish this workspace as:'}
          </span>
          <input
            autoFocus
            value={publishValue}
            onChange={(e) => setPublishValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPublish();
              if (e.key === 'Escape') setPublishOpen(false);
            }}
            className="flex-1 min-w-0 px-2 py-1 rounded border border-gray-600 bg-transparent text-sm font-mono text-gray-200"
          />
          <label className="flex items-center gap-1.5 text-xs text-gray-300 shrink-0 cursor-pointer" title={OPEN_DRAFT_TIP}>
            <input
              type="checkbox"
              checked={isOpenRef(publishValue)}
              onChange={(e) => setPublishValue(setOpenTag(publishValue, e.target.checked))}
            />
            open draft
          </label>
          <button
            onClick={submitPublish}
            disabled={publishing || !publishValue.trim()}
            className="px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 text-sm disabled:opacity-40"
          >
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
          <button onClick={() => setPublishOpen(false)} className="px-2 py-1 text-gray-400 hover:text-white text-sm">
            ✕
          </button>
        </div>
      )}
      {publishNotice && (
        <div role="status" className="bg-[#1b2a1b] border-b border-emerald-900 text-emerald-200 text-sm px-4 py-2 flex justify-between">
          <span className="font-mono">{publishNotice}</span>
          <button onClick={() => setPublishNotice(null)} className="text-emerald-400 hover:text-white">✕</button>
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
              headerExtra={
                <>
                  <button
                    onClick={() => setActiveView('layers')}
                    className="text-xs bg-gray-700 px-2 py-1 rounded hover:bg-gray-600 flex items-center gap-1"
                    title="The pod's layer stack (basis + local upper)"
                  >
                    <LayersIcon size={12} /> Layers
                  </button>
                  {route.mode !== 'ro' && (
                    <button
                      onClick={openPublish}
                      className="text-xs bg-blue-800 px-2 py-1 rounded hover:bg-blue-700 flex items-center gap-1"
                      title="Publish this workspace to the server (also: `artipod publish` in the terminal)"
                    >
                      <UploadCloud size={12} /> {publishing ? 'Publishing…' : 'Publish'}
                    </button>
                  )}
                </>
              }
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
        {/* Layers: reached from the File Explorer header — the pod's stack */}
        {activeView === 'layers' && (
          <div className="absolute inset-0 z-10 overflow-auto">
            <LayersView
              route={route}
              ready={fsReady}
              onPublish={route.mode !== 'ro' ? openPublish : undefined}
              onBack={() => setActiveView('tree')}
            />
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
