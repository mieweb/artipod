/**
 * PodSessionService (spa-ui-plan U3): the impure heart of a workspace,
 * extracted from the old app's 300-line boot effect. `open(route)` builds
 * the pod (encrypted block-store upper under a broker, authority adoption,
 * publish handler, push retry on the sync-machine + TaskScheduler, event
 * bridge into workspaceStore) and returns a session; `close()` drains and
 * disposes it before another workspace can register mounts or proc providers.
 *
 * Live objects (pod, sandbox, events) live HERE; stores get snapshots only.
 */
import type { PodEvents } from '@artipod/core/host';
import type { Sandbox } from '@artipod/core/sandbox';
import { actorId, keys, uiState, workspaceUrl, type Route } from '../boot';
import { FileSystemClosePersistenceError, flushFileSystem, initFileSystem } from '../filesystem';
import { openWorkspaceUpper } from './workspace-storage';
import { TaskScheduler } from './task-scheduler';
import { initialSyncState, reduceSync, wantsPush, type SyncEvent, type SyncState } from './sync-machine';
import { workspaceStore, initialWorkspace } from '../stores/workspace';
import { brokerStore } from '../stores/broker';
import { navigateTo } from '../stores/route';
import { nextDraftRef } from '../boot';
import { createBrowserRuntime, type BrowserRuntime } from '@artipod/core/apps';
import { catalogInventory } from './inventory';
import { disposeSessionResources, SessionDisposalError, SessionLifecycle, type SessionOpening } from './pod-session-lifecycle';
import { hostSave } from './host-save';
import { workspaceAutoPush } from './workspace-auto-push';

type Pod = Awaited<ReturnType<typeof import('@artipod/core').createZenFsPod>>;

export interface PodSession {
  route: Route;
  pod: Pod;
  sandbox: Sandbox;
  events: PodEvents;
  scheduler: TaskScheduler;
  runtime: BrowserRuntime;
  publish(target?: string): Promise<string>;
  /** Suggested publish target for the panel (fork → next free _ tag). */
  suggestPublishValue(): Promise<string>;
  /** Drain pending work and dispose this pod's mounts/subscriptions. */
  close(): Promise<void>;
}

export const PUSH_TASK = 'sync:push';
export const wsLockName = (id: string): string => `artipod-ws-${id}`;

// U5: sessions are strictly serialized — proc providers and overlay mounts
// are page-global, so the NEXT open must wait for the previous teardown
// (flush-push included) or the old dispose() tears down the new session's
// registrations (the "single-provider collision" landmine, observed live).
const lifecycle = new SessionLifecycle(bootPodSession, error => error instanceof FileSystemClosePersistenceError);
export type PodSessionOpening = SessionOpening<PodSession>;

export function openPodSession(route: Route): PodSessionOpening {
  return lifecycle.open(route);
}

async function bootPodSession(route: Route): Promise<PodSession> {
  let releaseWsLock: (() => void) | null = null;
  let cleanupPod: Pod | undefined;
  let cleanupSandbox: Sandbox | undefined;
  let cleanupRuntime: BrowserRuntime | undefined;
  let cleanupScheduler: TaskScheduler | undefined;
  let cleanupRearm: (() => void) | undefined;
  let cleanupBroker: (() => void) | undefined;
  let stopPreview: (() => void) | undefined;
  let releaseProbe: (() => void) | undefined;
  const offs: (() => void)[] = [];
  const releaseSaveTasks: (() => void)[] = [];
  const saveTask = (work: () => Promise<void>): (() => Promise<void>) => {
    releaseSaveTasks.push(() => hostSave.forget(work));
    return () => hostSave.run(work);
  };
  let closed = false;
  let disposed = false;
  let pushTerminated = false;
  const disposeResources = (): void => {
    if (disposed) return;
    disposed = true; closed = true; pushTerminated = true;
    disposeSessionResources([
      () => cleanupScheduler?.cancel(PUSH_TASK),
      () => cleanupRuntime?.dispose(),
      () => { if (stopPreview) window.removeEventListener('pagehide', stopPreview); },
      ...offs,
      () => cleanupBroker?.(),
      () => { for (const release of releaseSaveTasks) release(); },
      () => cleanupRearm?.(),
      () => releaseProbe?.(),
      () => cleanupSandbox?.dispose(),
      () => cleanupPod?.keyring.revokeAll(),
      () => cleanupPod?.dispose(),
      () => releaseWsLock?.(),
      () => {
        const debug = window as unknown as { __artipod?: unknown };
        if (debug.__artipod === cleanupPod) delete debug.__artipod;
      },
    ]);
  };
  try {
  workspaceStore.setState({ ...initialWorkspace, syncActive: route.isRef && route.mode === 'rw' });
  // Hold a lifetime lock so the catalog's sweeper knows this tab is alive.
  // U5: the session RELEASES it on close — navigation no longer reloads.
  try {
    void navigator.locks.request(
      wsLockName(route.id),
      { mode: 'shared' },
      () => new Promise<void>((resolve) => {
        if (closed) resolve();
        else releaseWsLock = resolve;
      }),
    ).catch(() => {});
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
  const svc = keys();
  const brokerKey = svc.getKey();
  const brokerLease = svc.getLease();
  let cowUpper: unknown;
  if (route.isRef && route.mode !== 'ro') {
    cowUpper = await openWorkspaceUpper({ ref: route.id });
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
      await flushFileSystem();
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
    await flushFileSystem();
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
  cleanupScheduler = scheduler;
  let syncState: SyncState = { ...initialSyncState, offline: svc.forcedOffline };
  // `kill <sync:push pid>` (TERM): no more runs, no re-arming, row retired —
  // the documented close semantics, not a cancel that the next edit undoes.
  const dispatch = (event: SyncEvent): void => {
    syncState = reduceSync(syncState, event);
    if (!pushTerminated && wantsPush(syncState, event) && event.type !== 'edit') void scheduler.run(PUSH_TASK);
  };

  // The session is a PID namespace (D16/D18) owned by the pod: shells, running
  // apps and tasks are its processes; `ps` / `kill` and /proc/<pid> read from
  // `pod.processes`, and `pod.dispose()` tears it down.
  const inventory = catalogInventory();

  const pod = await createZenFsPod(
    {
      mounts: [{ name: 'root', path: '/', source: { kind: 'backend', backend: info?.backend === 'opfs' ? 'opfs' : info?.backend === 'indexeddb' ? 'indexeddb' : 'memory' }, mode: 'rw' }],
    },
    {
      adopt: fs,
      storage: info ?? undefined,
      storagePolicy: 'protected',
      events,
      cwd: route.isRef ? undefined : blankRoot,
      oci: { transport: new ArtipodRegistryProxyTransport('/api/oci') },
      sync: {
        remote,
        actor,
        // The host owns the same two-second edit debounce below, so its save
        // boundary can await queued and in-flight automatic pushes.
        autoPush: false,
        ...(route.isRef ? { basis: { ref: route.id, upperConfig: cowUpper } } : {}),
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
                if (!(await svc.login(await actorId()))) throw new Error('broker login failed — is the serve still running with --encrypt?');
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
      inventory,
      identity: { kind: 'workspace', name: route.id, mode: route.mode, version: process.env.NEXT_PUBLIC_ARTIPOD_VERSION },
      extraCommands: [publishCmd],
    },
  );
  cleanupPod = pod;
  podRef = pod;
  const { processes } = pod;
  const sandbox = pod.createSandbox({ confineTo: pod.basis ? pod.basis.at : blankRoot });
  cleanupSandbox = sandbox;
  const exec = sandbox.exec.bind(sandbox);
  sandbox.exec = async (...args) => {
    const result = await exec(...args);
    await flushFileSystem();
    return result;
  };
  // per-artipod catalog badge: ref workspaces under a broker keep ciphertext
  await io.patch(route.id, { encrypted: !!info?.encrypted });

  // ── sync status + retry ────────────────────────────────────────────────────
  // The catalog's verdict rides push OUTCOMES, not trust in autoPush.
  // U5: every subscription is collected for close() — no page-lifetime leaks.
  const reportPersistenceFailure = (error: unknown): void => {
    console.error('workspace persistence failed:', error);
    if (!closed) workspaceStore.setState({ sync: { kind: 'failed', at: Date.now(), error: error instanceof Error ? error.message : String(error) } });
  };
  if (route.isRef && route.mode === 'rw') offs.push(workspaceAutoPush({
    events,
    push: () => pod.pushBasis(),
    enabled: () => !pushTerminated,
    onError: reportPersistenceFailure,
  }));
  let needsPush = route.mode === 'rw' && ((await io.read()).workspaces.find((e) => e.id === route.id)?.unsynced ?? false);
  if (needsPush) syncState = reduceSync(syncState, { type: 'push-fail' });
  offs.push(
    events.on('sync:push', (e) => {
      needsPush = !e.ok;
      void io.patch(route.id, { unsynced: !e.ok }).catch(reportPersistenceFailure);
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
  scheduler.register(PUSH_TASK, saveTask(async () => {
    if (pushTerminated || !needsPush || route.mode !== 'rw' || svc.forcedOffline) return;
    dispatch({ type: 'push-start' });
    const result = await pod.pushBasis();
    if (result && !result.pushed) {
      // nothing pending after all — the flag was stale
      needsPush = false;
      dispatch({ type: 'push-ok', at: Date.now() });
      await io.patch(route.id, { unsynced: false });
    }
  }));
  // Boot retry (an offline session left work behind). The slow 15 s interval
  // is armed by `rearm` below once this run has COMPLETED — scheduling here
  // would flip the task to `scheduled` mid-run and let a second push overlap.
  void scheduler.run(PUSH_TASK);
  const pushProcess = processes.spawn({ kind: 'task', name: PUSH_TASK, state: 'idle', signal: { TERM: () => {
    pushTerminated = true;
    scheduler.cancel(PUSH_TASK);
    pushProcess.exit();
  } } });
  const rearm = scheduler.onChange(() => {
    if (pushTerminated) return;
    const task = scheduler.list().find((t) => t.name === PUSH_TASK);
    if (task) pushProcess.update({ state: task.state, detail: task.lastResult ? { last: task.lastResult } : undefined });
    if (task && task.state === 'idle' && task.nextRunAt === undefined) scheduler.schedule(PUSH_TASK, 15_000);
  });
  cleanupRearm = rearm;
  // Reconnect + lease renewal: broker snapshots drive both retry and re-key.
  const updateBrokerLease = saveTask(async () => {
    const lease = svc.getLease();
    const key = svc.getKey();
    if (brokerStore.getState().status === 'locked') {
      await pod.locker.lock();
      return;
    }
    if (lease && key) {
      // Authenticate the renewed key with the core root before touching even
      // cached pod metadata. A newer lease supersedes this completion.
      await initFileSystem();
      if (svc.getLease() !== lease || svc.getKey() !== key) return;
      await pod.locker.adoptLease(lease, { [pod.oci.store.getSuperblock().podId]: key });
    }
  });
  const unsubBroker = brokerStore.subscribe(() => {
    if (brokerStore.getState().status === 'locked') {
      // The root is already locked, so audit persistence may fail. Revocation
      // must happen first and must never depend on an audit write succeeding.
      pod.keyring.revokeAll('kek:');
      void updateBrokerLease().catch((error) => console.warn('workspace lock audit unavailable:', error));
      return;
    }
    void updateBrokerLease().catch(reportPersistenceFailure);
    if (!pushTerminated) void scheduler.run(PUSH_TASK);
  });

  cleanupBroker = unsubBroker;

  // Track unpushed work for the catalog: probe the upper after changes/pushes.
  const upperAt = route.isRef ? `/.artipod/upper/${encodeURIComponent(route.id)}` : blankRoot;
  let probeTail: Promise<void> = Promise.resolve();
  const updateProbe = (): Promise<void> => {
    // A fresh probe can be admitted while the old read is still pending.
    // Preserve enqueue order, while allowing an explicit retry after failure.
    const operation = probeTail.catch(() => {}).then(async () => {
      if (closed) return;
      // `artipod offline on|off` in this shell flips the chip live
      try {
        const { readPodSettings } = await import('@artipod/core/oci');
        const offline = (await readPodSettings(fs as unknown as Parameters<typeof readPodSettings>[0])).offline === true;
        if (closed) return;
        svc.reconcileOffline(offline);
        // A status probe is not a reconnect. Re-dispatching online after each
        // failed push would immediately retry and queue another probe forever.
        if (svc.forcedOffline !== syncState.offline) dispatch({ type: svc.forcedOffline ? 'offline' : 'online' });
      } catch {
        // fs hiccup — mirror stands
      }
      const entries = (await fs.promises.readdir(upperAt).catch(() => [])) as string[];
      if (!closed) await io.patch(route.id, { hasChanges: entries.length > 0 });
    });
    probeTail = operation;
    return operation;
  };
  releaseProbe = () => hostSave.forget(updateProbe);
  const probe = (): void => {
    hostSave.schedule(updateProbe, 500, reportPersistenceFailure);
  };
  offs.push(events.on('fs:changed', probe));
  offs.push(events.on('sync:push', probe));
  probe();

  // demo/debug escape hatch (docs/console.md's future replacement)
  (window as unknown as { __artipod?: unknown }).__artipod = pod;
  workspaceStore.setState({ phase: 'ready', root: pod.basis ? pod.basis.at : blankRoot });

  const runtime = createBrowserRuntime({
    read: async path => new Uint8Array(await pod.zfs.promises.readFile(path)),
    list: async path => await pod.zfs.promises.readdir(path) as string[],
    stat: async path => await pod.zfs.promises.lstat(path),
  }, pod.basis ? pod.basis.at : blankRoot, { processes, detail: { pod: route.id } });
  cleanupRuntime = runtime;
  stopPreview = () => runtime.stop();
  window.addEventListener('pagehide', stopPreview);

  const session: PodSession = {
    route,
    pod,
    sandbox,
    events,
    scheduler,
    runtime,
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
      let failure: unknown;
      try {
        // Stop rearming before draining the current push. All resource releases
        // still run if cancellation, flushing, or one release itself fails.
        pushTerminated = true;
        scheduler.cancel(PUSH_TASK);
        if (route.isRef && route.mode === 'rw' && !svc.forcedOffline) {
          try {
            const result = await pod.pushBasis();
            if (result) await io.patch(route.id, { unsynced: false });
          } catch {
            // Server unreachable: the unsynced flag remains truthful.
          }
        }
        try { await flushFileSystem(); }
        catch (error) { throw new FileSystemClosePersistenceError(error); }
      } catch (error) { failure = error; }
      // A disposal error overrides the flush-only classification and blocks
      // the next boot. Successful disposal permits authenticated recovery.
      disposeResources();
      if (failure) throw failure;

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
  } catch (error) {
    try { disposeResources(); }
    catch (cleanupError) { throw new SessionDisposalError(new AggregateError([error, cleanupError], 'Workspace boot and cleanup failed')); }
    throw error;
  }
}
