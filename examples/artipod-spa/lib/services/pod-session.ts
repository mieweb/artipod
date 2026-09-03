/**
 * PodSessionService (spa-ui-plan U3): the impure heart of a workspace,
 * extracted from the old app's 300-line boot effect. `open(route)` builds
 * the pod (encrypted block-store upper under a broker, authority adoption,
 * publish handler, push retry on the sync-machine + TaskScheduler, event
 * bridge into workspaceStore) and returns a session; `close()` is the U5
 * teardown seam — a stub here, real disposal when reloads go away.
 *
 * Live objects (pod, sandbox, events) live HERE; stores get snapshots only.
 */
import type { PodEvents } from '@artipod/core/host';
import type { Sandbox } from '@artipod/core/sandbox';
import { keys, uiState, workspaceUrl, type Route } from '../boot';
import { initFileSystem } from '../filesystem';
import { upperDirName } from './ui-state';
import { TaskScheduler } from './task-scheduler';
import { initialSyncState, reduceSync, wantsPush, type SyncEvent, type SyncState } from './sync-machine';
import { workspaceStore, initialWorkspace } from '../stores/workspace';
import { brokerStore } from '../stores/broker';
import { navigateTo } from '../stores/route';
import { nextDraftRef } from '../boot';

type Pod = Awaited<ReturnType<typeof import('@artipod/core').createZenFsPod>>;

export interface PodSession {
  route: Route;
  pod: Pod;
  sandbox: Sandbox;
  events: PodEvents;
  scheduler: TaskScheduler;
  publish(target?: string): Promise<string>;
  /** Suggested publish target for the panel (fork → next free _ tag). */
  suggestPublishValue(): Promise<string>;
  /** U5 seam: dispose pod/mounts/subscriptions. Today navigation reloads. */
  close(): Promise<void>;
}

export const PUSH_TASK = 'sync:push';
export const wsLockName = (id: string): string => `artipod-ws-${id}`;

// U5: sessions are strictly serialized — proc providers and overlay mounts
// are page-global, so the NEXT open must wait for the previous teardown
// (flush-push included) or the old dispose() tears down the new session's
// registrations (the "single-provider collision" landmine, observed live).
let lifecycle: Promise<unknown> = Promise.resolve();

export function openPodSession(route: Route): Promise<PodSession> {
  const opened = lifecycle.catch(() => {}).then(() => bootPodSession(route));
  lifecycle = opened.catch(() => {});
  return opened;
}

async function bootPodSession(route: Route): Promise<PodSession> {
  workspaceStore.setState({ ...initialWorkspace, syncActive: route.isRef && route.mode === 'rw' });
  // Hold a lifetime lock so the catalog's sweeper knows this tab is alive.
  // U5: the session RELEASES it on close — navigation no longer reloads.
  let releaseWsLock: (() => void) | null = null;
  try {
    void navigator.locks.request(
      wsLockName(route.id),
      { mode: 'shared' },
      () => new Promise<void>((resolve) => {
        releaseWsLock = resolve;
      }),
    );
  } catch {
    // no Web Locks — the sweeper is conservative without it
  }
  const info = await initFileSystem();
  const { io } = await uiState();
  await io.recordWorkspace(route.id, route.isRef ? 'pod' : 'blank', route.mode);
  const actor = await io.actorId();
  const [{ createZenFsPod }, { ArtipodRegistryProxyTransport }, { HttpPodStore }, { fs }, { PodEvents: Events }] =
    await Promise.all([
      import('@artipod/core'),
      import('@artipod/core/oci'),
      import('@artipod/core/manager'),
      import('../filesystem'),
      import('@artipod/core/host'),
    ]);
  const events = new Events();
  workspaceStore.setState({ backend: info?.backend, isPrimaryTab: info?.isPrimaryTab ?? true });

  // Writable workspaces (rw AND cow) get a persistent upper keyed by ref —
  // one local working state per ref; the mode only chooses auto-push.
  const { mountConfigForSpec, encryptedStoreMount } = await import('@artipod/core/sandbox');
  const svc = keys();
  const brokerKey = svc.getKey();
  const brokerLease = svc.getLease();
  let cowUpper: unknown;
  if (route.isRef && route.mode !== 'ro') {
    if (brokerKey) {
      // Broker serve: the working tree is an opaque encrypted BLOCK STORE —
      // no filenames/tree shape on the backing medium; dir = hash(ref).
      const dirName = await upperDirName(route.id);
      const backing =
        info?.backend === 'opfs'
          ? {
              kind: 'opfs' as const,
              dir: ((await mountConfigForSpec({ type: 'opfs', dir: `.artipod/uppers/${dirName}` })) as { handle: FileSystemDirectoryHandle }).handle,
            }
          : { kind: 'config' as const, config: await mountConfigForSpec({ type: info?.backend ?? 'indexeddb', store: `artipod-upper::${dirName}` }) };
      cowUpper = await encryptedStoreMount({ backing, getKey: svc.requireKey });
    } else {
      cowUpper = await mountConfigForSpec(
        info?.backend === 'opfs'
          ? { type: 'opfs', dir: `.artipod/uppers/${encodeURIComponent(route.id)}` }
          : { type: 'indexeddb', store: `artipod-upper::${encodeURIComponent(route.id)}` },
      );
    }
  }
  const blankRoot = `/work/${route.id}`;
  if (!route.isRef) await fs.promises.mkdir(blankRoot, { recursive: true }).catch(() => {});
  // PAT prompt for git push/fetch to private repos (token kept off the sandbox fs)
  const { setAuthPrompt } = await import('@artipod/core/sandbox');
  setAuthPrompt(async (origin) => window.prompt(`Personal access token for ${origin} (stored in memory):`));
  const remote = new HttpPodStore('/api/pods');

  let podRef: Pod | null = null;

  // publish [<name:tag>] — the workspace's door to the server (docs/sync.md).
  const doPublish = async (target?: string): Promise<string> => {
    const pod = podRef;
    if (!pod) throw new Error('workspace still opening — try again');
    if (route.mode === 'ro') throw new Error('read-only workspace');
    const { pushOverlay } = await import('@artipod/core/manager');
    const { sha256 } = await import('@artipod/core/oci');
    const store = pod.oci.store;
    const MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';
    const enc = new TextEncoder();
    if (!target || target === route.id) {
      if (!route.isRef)
        throw new Error('a blank workspace needs a name — publish <name:tag>, e.g. publish me/scratch:_1 (_-tags stay open; others seal on first push)');
      // push back — pushOverlay directly so a server refusal surfaces here
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
      await io.patch(route.id, { hasChanges: false });
      return `pushed ${route.id}: ${result.overlayLayers} overlay layer(s) → ${result.manifestDigest.slice(0, 19)}…`;
    }
    if (!target.includes(':'))
      throw new Error(`include a tag — e.g. publish ${target}:_1 (_ = open; without _ it seals on first push)`);
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
      // a cow fork migrates; NEVER empty an rw upper (its layers mirror the head)
      for (const name of (await fs.promises.readdir(upperAt).catch(() => [])) as string[]) {
        await fs.promises.rm(`${upperAt}/${name}`, { recursive: true }).catch(() => {});
      }
      deletions.clear();
      await io.patch(route.id, { hasChanges: false });
    } else {
      // the blank workspace IS the ref now — retire the anonymous copy
      await fs.promises.rm(blankRoot, { recursive: true }).catch(() => {});
      await io.drop([route.id]);
    }
    setTimeout(() => {
      navigateTo(target, 'rw'); // U5: client-side — this session closes on the way
    }, 800);
    return `published ${target} (${result.overlayLayers} layer(s) over ${route.isRef ? `${route.id}'s basis` : 'an empty basis'}) — opening it read-write…`;
  };

  const { defineCommand } = await import('just-bash/browser');
  const publishCmd = defineCommand('publish', async (cmdArgs: string[]) => {
    try {
      return { stdout: `${await doPublish(cmdArgs[0])}\n`, stderr: '', exitCode: 0 };
    } catch (e) {
      return { stdout: '', stderr: `publish: ${(e as Error).message}\n`, exitCode: 1 };
    }
  });

  // Push retry rides the sync-machine + a NAMED task (visible in artipod ps).
  const scheduler = svc.scheduler;
  let syncState: SyncState = { ...initialSyncState, offline: svc.forcedOffline };
  const dispatch = (event: SyncEvent): void => {
    syncState = reduceSync(syncState, event);
    if (wantsPush(syncState, event) && event.type !== 'edit') void scheduler.run(PUSH_TASK);
  };

  const pod = await createZenFsPod(
    {
      mounts: [{ name: 'root', path: '/', source: { kind: 'backend', backend: info?.backend ?? 'indexeddb' }, mode: 'rw' }],
    },
    {
      adopt: fs,
      events,
      cwd: route.isRef ? undefined : blankRoot,
      oci: { transport: new ArtipodRegistryProxyTransport('/api/oci') },
      sync: {
        remote,
        actor,
        ...(route.isRef ? { basis: { ref: route.id, upperConfig: cowUpper }, autoPush: route.mode === 'rw' } : {}),
      },
      hydration: {
        policy: { default: 'lazy' },
        onDemand: 'fetch',
        ...(route.isRef ? { defaultRef: route.id } : {}),
      },
      // Broker mode: the pod's local blob store encrypts at rest with the
      // leased KEK, adopted at boot (before the basis pull writes a byte).
      authority:
        brokerKey && brokerLease
          ? {
              encrypt: true,
              adopt: { lease: brokerLease, key: brokerKey },
              login: async () => {
                if (!(await svc.login(actor))) throw new Error('broker login failed — is the serve still running with --encrypt?');
                const lease = svc.getLease();
                const key = svc.getKey();
                const podId = podRef?.oci.store.getSuperblock().podId;
                if (!lease || !key || !podId) throw new Error('broker login failed');
                return { lease, cryptoKeys: { [podId]: key } };
              },
            }
          : undefined,
      onEdit: (path) => {
        workspaceStore.setState({ editingFile: path, activeView: 'editor' });
      },
      publish: doPublish,
      // `artipod ps` in this shell shows the client's live schedule.
      tasks: () => scheduler.list(),
      extraCommands: [publishCmd],
    },
  );
  podRef = pod;
  const sandbox = pod.createSandbox({ confineTo: pod.basis ? pod.basis.at : blankRoot });
  // per-artipod catalog badge: ref workspaces under a broker keep ciphertext
  await io.patch(route.id, { encrypted: !!brokerKey && route.isRef });

  // ── sync status + retry ────────────────────────────────────────────────────
  // The catalog's verdict rides push OUTCOMES, not trust in autoPush.
  // U5: every subscription is collected for close() — no page-lifetime leaks.
  const offs: (() => void)[] = [];
  let needsPush = route.mode === 'rw' && ((await io.read()).workspaces.find((e) => e.id === route.id)?.unsynced ?? false);
  if (needsPush) syncState = reduceSync(syncState, { type: 'push-fail' });
  offs.push(
    events.on('sync:push', (e) => {
      needsPush = !e.ok;
      void io.patch(route.id, { unsynced: !e.ok });
      dispatch(e.ok ? { type: 'push-ok', at: Date.now() } : { type: 'push-fail' });
      workspaceStore.setState({
        sync: e.ok ? { kind: 'synced', at: Date.now(), layers: e.layers } : { kind: 'failed', at: Date.now(), error: e.error },
      });
    }),
  );
  offs.push(
    events.on('fs:changed', () => {
      dispatch({ type: 'edit' });
      workspaceStore.setState((s) => (s.sync.kind === 'failed' ? s : { ...s, sync: { kind: 'pending' } }));
    }),
  );
  scheduler.register(PUSH_TASK, async () => {
    if (!needsPush || route.mode !== 'rw' || svc.forcedOffline) return;
    dispatch({ type: 'push-start' });
    const result = await pod.pushBasis();
    if (result && !result.pushed) {
      // nothing pending after all — the flag was stale
      needsPush = false;
      dispatch({ type: 'push-ok', at: Date.now() });
      void io.patch(route.id, { unsynced: false });
    }
  });
  void scheduler.run(PUSH_TASK); // boot retry (offline session left work behind)
  scheduler.schedule(PUSH_TASK, 15_000); // slow interval; re-armed after each run
  const rearm = scheduler.onChange(() => {
    const task = scheduler.list().find((t) => t.name === PUSH_TASK);
    if (task && task.state === 'idle' && task.nextRunAt === undefined) scheduler.schedule(PUSH_TASK, 15_000);
  });
  // Reconnect + lease renewal: broker snapshots drive both retry and re-key.
  const unsubBroker = brokerStore.subscribe(() => {
    void scheduler.run(PUSH_TASK);
    const lease = svc.getLease();
    const key = svc.getKey();
    if (lease && key) void pod.locker.adoptLease(lease, { [pod.oci.store.getSuperblock().podId]: key });
    else if (brokerStore.getState().status === 'locked') void pod.locker.lock();
  });

  // Track unpushed work for the catalog: probe the upper after changes/pushes.
  const upperAt = route.isRef ? `/.artipod/upper/${encodeURIComponent(route.id)}` : blankRoot;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  const probe = (): void => {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      // `artipod offline on|off` in this shell flips the chip live
      void (async () => {
        try {
          const { readPodSettings } = await import('@artipod/core/oci');
          svc.reconcileOffline((await readPodSettings(fs as unknown as Parameters<typeof readPodSettings>[0])).offline === true);
          dispatch({ type: svc.forcedOffline ? 'offline' : 'online' });
        } catch {
          // fs hiccup — mirror stands
        }
        const entries = (await fs.promises.readdir(upperAt).catch(() => [])) as string[];
        await io.patch(route.id, { hasChanges: entries.length > 0 });
      })();
    }, 500);
  };
  offs.push(events.on('fs:changed', probe));
  offs.push(events.on('sync:push', probe));
  probe();

  // demo/debug escape hatch (docs/console.md's future replacement)
  (window as unknown as { __artipod?: unknown }).__artipod = pod;
  workspaceStore.setState({ phase: 'ready', root: pod.basis ? pod.basis.at : blankRoot });

  const session: PodSession = {
    route,
    pod,
    sandbox,
    events,
    scheduler,
    publish: doPublish,
    async suggestPublishValue(): Promise<string> {
      if (!route.isRef) return `me/${route.id}:_1`;
      if (route.mode !== 'cow') return route.id;
      try {
        const refs = (await (await fetch('/api/pods/refs')).json()) as { ref: string }[];
        return nextDraftRef(route.id, new Set(refs.map((r) => r.ref)));
      } catch {
        return route.id; // offline — plain suggestion
      }
    },
    async close(): Promise<void> {
      const closing = (async () => {
        // Flush-on-close (U5): a mid-flight or pending push finishes BEFORE the
        // pod dies — the aborted-push residue from reload-navigation, fixed
        // properly. Offline or ro: nothing to flush; the registry flag stands.
        if (route.isRef && route.mode === 'rw' && !svc.forcedOffline) {
          try {
            const result = await pod.pushBasis();
            if (result) {
              void io.patch(route.id, { unsynced: false });
            }
          } catch {
            // server unreachable — unsynced flag remains truthful
          }
        }
        // Unsubscribe audit: every listener this session attached comes off.
        for (const off of offs) off();
        unsubBroker();
        rearm();
        scheduler.cancel(PUSH_TASK);
        if (probeTimer) clearTimeout(probeTimer);
        // Pod teardown: overlay/upper unmounts + proc providers (pod manifest,
        // keys, hydration) unregister — the next session must not collide.
        pod.dispose();
        releaseWsLock?.();
        const w = window as unknown as { __artipod?: unknown };
        if (w.__artipod === pod) delete w.__artipod;
      })();
      lifecycle = lifecycle.catch(() => {}).then(() => closing);
      return closing;
    },
  };

  // Catalog one-step flow: /?artipod=<id>&publish=<name:tag>
  if (route.publishIntent) {
    window.history.replaceState(null, '', workspaceUrl(route.id, route.mode));
    try {
      workspaceStore.setState((s) => ({ publish: { ...s.publish, notice: null } }));
      const notice = await doPublish(route.publishIntent);
      workspaceStore.setState((s) => ({ publish: { ...s.publish, notice } }));
    } catch (e) {
      workspaceStore.setState((s) => ({ publish: { ...s.publish, notice: `publish ${route.publishIntent}: ${(e as Error).message}` } }));
    }
  }

  return session;
}
