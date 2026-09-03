'use client';

/**
 * `/` — every artipod in reach (spa-ui-plan U2): the old app's catalog on
 * zustand snapshots. Rendering reads catalogStore/registryStore/brokerStore;
 * all data flow lives in lib/services/catalog-refresh. Badge/chip tooltips
 * carried over verbatim — they encode the honest semantics.
 */
import { useCallback, useEffect, useState } from 'react';
import dynamicImport from 'next/dynamic';
import { useStore } from 'zustand';
import { Terminal as LucideTerminal, Plus, Server, HardDrive } from 'lucide-react';
import type { Sandbox } from '@artipod/core/sandbox';
import { catalogStore, refreshServer, E2E_MEDIA_TYPE } from '@/lib/stores/catalog';
import { registryStore } from '@/lib/stores/registry';
import { brokerStore } from '@/lib/stores/broker';
import { refreshLocal, refreshVerdicts } from '@/lib/services/catalog-refresh';
import { OPEN_DRAFT_TIP, isOpenRef, nextDraftRef, setOpenTag, workspaceUrl, type OpenMode } from '@/lib/boot';
import { navClick, navigateTo } from '@/lib/stores/route';
import EncryptionBadge from '@/components/EncryptionBadge';
import OfflineToggle from '@/components/OfflineToggle';

const Terminal = dynamicImport(() => import('@/components/Terminal'), { ssr: false });

export default function Catalog({ actorId }: { actorId: () => Promise<string> }) {
  const { serverRefs, localHeads, verdicts, changedRefs } = useStore(catalogStore);
  const local = useStore(registryStore, (s) => s.entries);
  const brokerStatus = useStore(brokerStore, (s) => s.status);
  const [rootSandbox, setRootSandbox] = useState<Sandbox | null>(null);
  const [termOpen, setTermOpen] = useState(false);
  const [termHeight, setTermHeight] = useState(300);
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(new Set());
  const [pub, setPub] = useState<{ id: string; mode: OpenMode; value: string } | null>(null);

  useEffect(() => {
    void refreshServer();
    let disposeEvents: (() => void) | null = null;
    (async () => {
      await refreshLocal();
      // root console over the raw fs — /proc, every workspace, pod internals;
      // its commands rescan the lists (fs:changed after every exec)
      try {
        const { fs } = await import('@/lib/filesystem');
        const { createSandbox } = await import('@artipod/core/sandbox');
        const { PodEvents: Events } = await import('@artipod/core/host');
        const { defineCommand } = await import('just-bash/browser');
        // The safe alternative to rm -rf: erases ONLY artipod state and
        // reloads a factory-fresh machine. Server pods are untouched.
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
          } finally {
            setTimeout(() => window.location.reload(), 500);
          }
          return { stdout: 'local artipod data erased — reloading a factory-fresh machine…\n', stderr: '', exitCode: 0 };
        });
        const consoleEvents = new Events();
        let timer: ReturnType<typeof setTimeout> | null = null;
        disposeEvents = consoleEvents.on('fs:changed', () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => void refreshLocal().then(refreshVerdicts), 300);
        });
        setRootSandbox(createSandbox({ zfs: fs, cwd: '/', proc: true, events: consoleEvents, extraCommands: [factoryReset] }));
      } catch {
        // fs init failed — no console
      }
    })();
    return () => disposeEvents?.();
  }, []);

  // Ancestry verdicts follow server refs + local heads.
  useEffect(() => {
    void refreshVerdicts();
  }, [serverRefs, localHeads]);

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

  const changed = new Set(changedRefs);
  const localById = new Map(local.map((e) => [e.id, e]));
  // cow-opened pods with unpushed writes have FORKED — they belong to this machine
  const cowForks = local.filter((e) => e.kind === 'pod' && e.mode === 'cow' && changed.has(e.id));
  const localOnly = [...cowForks, ...local.filter((e) => !serverRefs?.some((r) => r.ref === e.id) && !cowForks.includes(e))];

  // Per-artipod encryption chips: shown once ANY encryption is in play.
  const encryptionInPlay =
    brokerStatus !== 'none' || (serverRefs ?? []).some((r) => r.encrypted) || local.some((e) => e.encrypted);
  const cryptoChip = (state: 'e2e' | 'encrypted' | 'plaintext') =>
    !encryptionInPlay ? null : state === 'plaintext' ? (
      <span
        className="rounded bg-gray-800 px-1.5 py-0.5 text-gray-500"
        title="stored unencrypted — content written before --encrypt (or a blank scratch tree); republish to encrypt"
      >
        plaintext
      </span>
    ) : (
      <span
        className="rounded bg-emerald-900/60 px-1.5 py-0.5"
        title={
          state === 'e2e'
            ? 'end-to-end encrypted envelope — the server never sees plaintext; keys move out-of-band'
            : 'ciphertext at rest — readable only through a key lease'
        }
      >
        🔒 {state === 'e2e' ? 'e2e' : 'encrypted'}
      </span>
    );

  const row = (id: string, badge: React.ReactNode, note: string, mode: OpenMode = 'rw', label?: string) => (
    <li key={`${id}:${mode}`}>
      {/* U5: client-side navigation — the href stays for copy/new-tab */}
      <a
        href={workspaceUrl(id, mode)}
        onClick={(e) => navClick(e, id, mode)}
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded bg-[#333] px-3 py-2 text-sm hover:bg-[#3d3d3d]"
      >
        <span className="min-w-0 flex-1 basis-40 truncate font-mono">{label ?? id}</span>
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
        <a
          key={m}
          href={workspaceUrl(ref, m)}
          onClick={(e) => {
            e.stopPropagation();
            navClick(e, ref, m);
          }}
          title={m === 'rw' ? 'writes auto-push to the server' : m === 'cow' ? 'writes stay on this machine (fork)' : 'read-only'}
          className="rounded border border-gray-600 px-1.5 py-0.5 text-[10px] uppercase text-gray-400 hover:border-gray-400 hover:text-white"
        >
          {m}
        </a>
      ))}
    </span>
  );

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
    <main className="flex h-[var(--app-height)] flex-col overflow-hidden bg-black text-white">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-lg p-6">
          <div className="mb-1 flex items-center gap-2">
            <h1 className="text-2xl font-bold">artipod</h1>
            <EncryptionBadge principal={actorId} />
            <OfflineToggle />
          </div>
          <p className="mb-6 text-sm text-gray-400">
            a pod for artifacts — files that version, sync, and run tools, right here in the browser.
          </p>

          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-300">
            <Server size={14} /> On this server
          </h2>
          {serverRefs === null ? (
            <p className="mb-6 text-sm text-gray-500">loading…</p>
          ) : serverRefs.length === 0 ? (
            <p className="mb-6 text-sm text-gray-500">
              nothing published — <code>artipod serve --publish &lt;dir&gt;</code>
            </p>
          ) : (
            <ul className="mb-6 space-y-2">
              {Array.from(
                serverRefs.reduce((groups, r) => {
                  const i = r.ref.lastIndexOf(':');
                  const name = i === -1 ? r.ref : r.ref.slice(0, i);
                  (groups.get(name) ?? groups.set(name, []).get(name)!).push(r);
                  return groups;
                }, new Map<string, typeof serverRefs>()),
              )
                .sort(([, refsA], [, refsB]) => {
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
                  const renderRef = (
                    { ref, manifestDigest, locked, encrypted, mediaType }: (typeof serverRefs)[number],
                    label?: string,
                    extra?: React.ReactNode,
                  ) => {
                    const opened = localById.get(ref);
                    const isCowFork = cowForks.some((e) => e.id === ref);
                    return row(
                      ref,
                      <>
                        {manifestDigest && (
                          <span className="font-mono text-gray-500" title={manifestDigest}>
                            @{manifestDigest.replace(/^sha256:/, '').slice(0, 8)}
                          </span>
                        )}
                        {cryptoChip(mediaType === E2E_MEDIA_TYPE ? 'e2e' : encrypted ? 'encrypted' : 'plaintext')}
                        {locked && (
                          <span
                            className="rounded bg-amber-900/60 px-1.5 py-0.5"
                            title="tag is locked — the head cannot move; fork with cow and publish under a new name"
                          >
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
                        {!isCowFork &&
                          (() => {
                            const verdict = verdicts[ref];
                            if (verdict === 'ahead' || (verdict === undefined && opened?.unsynced)) {
                              return (
                                <span
                                  className="rounded bg-amber-900/60 px-1.5 py-0.5"
                                  title="local changes haven't reached the server (push interrupted or offline) — open the workspace and it pushes automatically"
                                >
                                  out of sync
                                </span>
                              );
                            }
                            if (changed.has(ref)) return <span className="rounded bg-emerald-900/60 px-1.5 py-0.5">local changes</span>;
                            if (verdict === 'behind') {
                              return (
                                <span
                                  className="rounded bg-sky-900/60 px-1.5 py-0.5 text-sky-200"
                                  title="the server tag moved since this machine last synced — open the workspace to pull the newer head"
                                >
                                  update available
                                </span>
                              );
                            }
                            if (verdict === 'synced') {
                              return (
                                <span
                                  className="rounded bg-gray-700 px-1.5 py-0.5"
                                  title={`verified: local head matches the server (@${manifestDigest?.replace(/^sha256:/, '').slice(0, 8)})`}
                                >
                                  synced
                                </span>
                              );
                            }
                            return null; // no local head or no verdict — claim nothing
                          })()}
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
                              className="rounded border border-gray-600 px-1.5 py-0.5 text-[10px] text-gray-400 hover:border-gray-400 hover:text-white"
                              title={`${older.length} older tag${older.length === 1 ? '' : 's'} in ${name}`}
                            >
                              {isOpen ? '▾' : '▸'} +{older.length}
                            </button>
                          ) : undefined,
                        )}
                        {isOpen && (
                          <ul className="ml-2 space-y-1 border-l border-gray-700 pl-4">
                            {older.map((r) => renderRef(r, `:${r.ref.slice(r.ref.lastIndexOf(':') + 1)}`))}
                          </ul>
                        )}
                      </ul>
                    </li>
                  );
                })}
            </ul>
          )}

          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-300">
            <HardDrive size={14} /> On this machine
          </h2>
          {localOnly.length === 0 ? (
            <p className="mb-6 text-sm text-gray-500">no local workspaces yet</p>
          ) : (
            <ul className="mb-6 space-y-2">
              {localOnly.map((e) => {
                // a cow fork IS a pending draft — show it under the _ name it will publish as
                const draftName =
                  e.kind === 'pod' && e.mode === 'cow' ? nextDraftRef(e.id, new Set((serverRefs ?? []).map((r) => r.ref))) : null;
                return row(
                  e.id,
                  <>
                    {cryptoChip(e.encrypted ? 'encrypted' : 'plaintext')}
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
                      className="rounded border border-gray-600 px-1.5 py-0.5 text-[10px] uppercase text-gray-400 hover:border-gray-400 hover:text-white"
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

          {pub && (
            <div className="mb-6 flex flex-wrap items-center gap-2">
              <span className="basis-full font-mono text-xs text-gray-400 sm:shrink-0 sm:basis-auto">publish {pub.id} as</span>
              <input
                autoFocus
                value={pub.value}
                onChange={(e) => setPub({ ...pub, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setPub(null);
                  if (e.key === 'Enter' && pub.value.trim()) {
                    navigateTo(pub.id, pub.mode, `&publish=${encodeURIComponent(pub.value.trim())}`);
                  }
                }}
                className="min-w-0 flex-1 rounded border border-gray-600 bg-transparent px-2 py-1 font-mono text-sm text-gray-200"
              />
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-300" title={OPEN_DRAFT_TIP}>
                <input
                  type="checkbox"
                  checked={isOpenRef(pub.value)}
                  onChange={(e) => setPub({ ...pub, value: setOpenTag(pub.value, e.target.checked) })}
                />
                open draft
              </label>
              <button
                onClick={() => {
                  if (pub.value.trim()) navigateTo(pub.id, pub.mode, `&publish=${encodeURIComponent(pub.value.trim())}`);
                }}
                className="rounded bg-blue-700 px-3 py-1 text-sm hover:bg-blue-600"
              >
                Publish
              </button>
              <button onClick={() => setPub(null)} className="px-2 py-1 text-sm text-gray-400 hover:text-white">
                ✕
              </button>
            </div>
          )}

          <NewWorkspace />

          <button
            onClick={() => setTermOpen((o) => !o)}
            disabled={!rootSandbox}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded border border-gray-700 px-3 py-2 text-sm text-gray-400 hover:bg-[#222] disabled:opacity-40"
            title="Root console over the whole browser filesystem"
          >
            <LucideTerminal size={14} /> Root console — inspect /proc, /work, everything{' '}
            <kbd className="rounded border border-gray-600 bg-[#333] px-1 font-mono text-[10px]">ctrl+`</kbd>
          </button>
        </div>
      </div>

      {/* Root console: the unconfined shell — workspaces get a confined one */}
      <div className="shrink-0 overflow-hidden border-t border-gray-700 bg-[#1e1e1e]" style={{ height: termOpen ? termHeight : 0 }}>
        <div
          onPointerDown={onDividerPointerDown}
          className="h-1.5 cursor-row-resize bg-[#2d2d2d] transition-colors hover:bg-blue-500"
          title="Drag to resize"
        />
        <div style={{ height: termOpen ? termHeight - 6 : 0 }}>{rootSandbox && <Terminal sandbox={rootSandbox} />}</div>
      </div>
    </main>
  );
}

/** New workspace: blank, or named-and-published in a single step (?publish= intent). */
function NewWorkspace() {
  const [name, setName] = useState('');
  const [openDraft, setOpenDraft] = useState(true);
  const go = () => {
    const id = crypto.randomUUID().slice(0, 8);
    const target = name.trim();
    if (!target) return navigateTo(id);
    const ref = setOpenTag(target.includes(':') ? target : `${target}:1`, openDraft);
    navigateTo(id, 'rw', `&publish=${encodeURIComponent(ref)}`);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()}
        placeholder="name (optional — publishes right away)"
        className="min-w-0 flex-1 rounded border border-gray-600 bg-transparent px-3 py-2 font-mono text-sm text-gray-200 placeholder-gray-500"
      />
      {name.trim() && (
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-gray-300" title={OPEN_DRAFT_TIP}>
          <input type="checkbox" checked={openDraft} onChange={(e) => setOpenDraft(e.target.checked)} />
          open draft
        </label>
      )}
      <button
        onClick={go}
        className="flex shrink-0 items-center justify-center gap-2 rounded border border-gray-600 px-3 py-2 text-sm text-gray-300 hover:bg-[#333]"
      >
        <Plus size={14} /> {name.trim() ? 'Create & publish' : 'New blank workspace'}
      </button>
    </div>
  );
}
