'use client';

/**
 * Routing (?artipod=<ref-or-id>&mode=rw|cow|ro, static-export friendly).
 * U5: transitions are CLIENT-SIDE — no reloads. The workspace is keyed by
 * route so switching pods unmounts the old session (PodSessionService.close
 * flushes + disposes) and boots the next in the same page.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import Catalog from '@/components/Catalog';
import Workspace from '@/components/Workspace';
import { actorId, keys } from '@/lib/boot';
import { initRouting, routeStore } from '@/lib/stores/route';
import { brokerStore } from '@/lib/stores/broker';
import { fileSystemNeedsRecovery, getFileSystemSnapshot, getServerFileSystemSnapshot, initFileSystem, recoverFileSystem, subscribeFileSystem } from '@/lib/filesystem';
import EncryptionBadge from '@/components/EncryptionBadge';
import OfflineToggle from '@/components/OfflineToggle';

type BootState = { phase: 'loading' | 'ready' | 'locked' | 'error'; message?: string; memoryOnly?: boolean; canRecover?: boolean };

export default function Page() {
  const route = useStore(routeStore, (s) => s.route);
  const broker = useStore(brokerStore);
  const storage = useSyncExternalStore(subscribeFileSystem, getFileSystemSnapshot, getServerFileSystemSnapshot);
  const [boot, setBoot] = useState<BootState>({ phase: 'loading' });
  const [retry, setRetry] = useState({ version: 0, recover: false });

  useEffect(() => {
    const svc = keys();
    let cancelled = false;
    let generation = 0;
    let installed = false;
    let usableKey: CryptoKey | null = null;
    const openRoot = async (recover = false): Promise<void> => {
      const attempt = ++generation;
      setBoot({ phase: 'loading' });
      try {
        if (svc.storagePolicy === 'unknown') {
          throw new Error(svc.probeError ?? 'Cannot determine whether this server requires encrypted browser storage. Reconnect and retry.');
        }
        if (svc.storagePolicy === 'encrypted' && !svc.getKey()) {
          if (!cancelled && attempt === generation) setBoot({ phase: 'locked' });
          return;
        }
        // No catalog, registry, console or workspace may touch the root until
        // its required key is available and the protected filesystem opens.
        const recovery = recover ? await recoverFileSystem() : null;
        const info = recovery?.info ?? await initFileSystem();
        if (cancelled || attempt !== generation) return;
        if (svc.storagePolicy === 'encrypted' && !svc.getKey()) {
          setBoot({ phase: 'locked' });
          return;
        }
        initRouting();
        setBoot({ phase: 'ready', memoryOnly: (info as { memoryOnly?: boolean } | null)?.memoryOnly, message: recovery?.warning });
      } catch (error) {
        if (cancelled || attempt !== generation) return;
        setBoot({ phase: 'error', message: error instanceof Error ? error.message : String(error), canRecover: fileSystemNeedsRecovery() });
      }
    };
    const off = brokerStore.subscribe(() => {
      if (!installed || cancelled) return;
      const nextKey = svc.getKey();
      if (brokerStore.getState().status === 'locked') {
        generation += 1;
        usableKey = null;
        setBoot({ phase: 'locked' });
      } else if (nextKey && nextKey !== usableKey) {
        usableKey = nextKey;
        void openRoot();
      }
    });
    void (async () => {
      try {
        await svc.install(actorId);
        if (cancelled) return;
        installed = true;
        usableKey = svc.getKey();
        await openRoot(retry.recover);
      } catch (error) {
        if (!cancelled) setBoot({ phase: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => { cancelled = true; generation += 1; off(); };
  }, [retry]);

  const expired = broker.status === 'leased' && (!broker.expiresAt || broker.expiresAt <= Date.now());
  const locked = broker.status === 'locked' || expired || boot.phase === 'locked';
  const storageFailed = storage.status === 'failed' || (storage.needsRecovery && storage.status !== 'recovering' && storage.status !== 'resetting');
  const canRecover = storage.needsRecovery || !!boot.canRecover;
  if (locked || boot.phase === 'error' || storageFailed) {
    return (
      <main
        className="flex h-[var(--app-height)] items-center justify-center p-6"
        style={{ background: 'var(--mieweb-background, #000)', color: 'var(--mieweb-foreground, #fff)' }}
      >
        <section className="max-w-lg space-y-4" aria-label="Browser storage access">
          <h1 className="text-xl font-semibold">{locked ? 'Browser storage is locked' : 'Browser storage could not open'}</h1>
          <p role="status">
            {locked
              ? 'Log in to unlock your encrypted workspaces. If you are offline and your key lease has expired, reconnect before logging in.'
              : boot.phase === 'error' ? boot.message : 'A write to browser storage could not be saved.'}
          </p>
          {!locked && canRecover && <p>Reopen the saved storage generation to recover from the failed write. Unsaved editor drafts remain in this tab; review and save them again after recovery.</p>}
          <div className="flex flex-wrap items-center gap-3">
            <EncryptionBadge principal={actorId} />
            <OfflineToggle />
            <button
              type="button"
              className="rounded border px-3 py-1.5 text-sm"
              style={{ borderColor: 'var(--mieweb-border, #888)' }}
              onClick={() => setRetry(value => ({ version: value.version + 1, recover: !locked && canRecover }))}
            >{!locked && canRecover ? 'Recover saved storage' : 'Retry opening storage'}</button>
          </div>
        </section>
      </main>
    );
  }

  if (boot.phase !== 'ready' || route === undefined) return (
    <main className="h-[var(--app-height)] p-6" style={{ background: 'var(--mieweb-background, #000)', color: 'var(--mieweb-foreground, #fff)' }}>
      <p role="status">Opening browser storage…</p>
    </main>
  );
  return (
    <div className="flex h-[var(--app-height)] flex-col">
      {boot.message && <p role="alert" className="shrink-0 border-b px-4 py-2 text-sm">{boot.message}</p>}
      {boot.memoryOnly && (
        <p role="alert" className="shrink-0 border-b px-4 py-2 text-sm" style={{ background: 'var(--mieweb-muted, #333)', borderColor: 'var(--mieweb-border, #888)' }}>
          Memory-only workspace: this server does not provide an encryption key. Local edits disappear when this page closes or reloads; publish or download your work to keep it.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden [&>main]:h-full">
        {route === null ? <Catalog actorId={actorId} /> : <Workspace key={`${route.id}:${route.mode}`} route={route} />}
      </div>
    </div>
  );
}
