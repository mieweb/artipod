/**
 * realizeZenFs — mount a PodManifest onto a ZenFS graph (browser + Node),
 * and createZenFsPod — the realized pod: one store, coherent views for
 * shell, tools, /proc and events (plan Phase 3).
 *
 * Sources:
 *   - backend (memory | indexeddb | opfs): virtual stores, browser + Node
 *     (indexeddb/opfs need the DOM backends and exist in browsers)
 *   - hostDir: ZenFS Passthrough over node:fs — Node only; browsers must
 *     sync the pod instead (plan collision #4 mirror)
 *   - volume: arrives with the OCI store (Phase 4)
 *
 * Modes: `rw` mounts as-is; `cow` stacks a CopyOnWrite upper (InMemory) over
 * the source so writes never reach it; `ro` is enforced by the tool layer
 * (ArtiMount readonly) — the shell can still write to a ro zenfs mount until
 * OciViewFS lands in Phase 4 (documented limitation; docker enforces `:ro`
 * for real today).
 *
 * @zenfs/core (+@zenfs/dom for indexeddb/opfs) are optional peers, imported
 * dynamically so nothing heavy loads until a pod is realized.
 */

import { validateManifest, type PodManifest } from '../manifest.js';
import { PodEvents } from '../events.js';
import { ArtiMount } from '../artimount.js';
import type { PodFs } from '../podfs.js';
import { createSandbox, type CreateSandboxOptions } from '../sandbox/index.js';
import type { Sandbox, ZenFsLike } from '../sandbox/types.js';
import { PodPathResolver, createPodFileTools } from '../tools/podFileTools.js';
import type { ToolHandler } from '../tools/types.js';
import { createSandboxTools } from '../agent/tools.js';
import type { ToolHandler as AgentToolHandler } from '../agent/types.js';
import { registerPodManifestProvider } from '../proc/pod-provider.js';
import { registerProcProvider } from '../proc/registry.js';
import { Keyring, makeKeysProcProvider } from '../manager/keyring.js';
import { PodLocker } from '../manager/locker.js';
import { AuditLog } from '../manager/audit.js';
import { ApprovalBroker } from '../manager/approval.js';
import { Hydrator, makePrefetchTool, type HydrationPolicy } from '../manager/hydration.js';
import { pushOverlay } from '../manager/overlay-sync.js';
import { OciStore } from '../oci/store.js';
import { makeArtipodCommand } from '../oci/command.js';
import type { OciTransport } from '../oci/transport.js';
import { SnapshotManager } from '../oci/snapshot.js';
import type { ToolCallingLoopOptions } from '../agent/types.js';

export interface RealizedZenFsMount {
  name: string;
  path: string;
  readonly: boolean;
}

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

/** Resolve one mount source to a ZenFS mount config object. */
async function mountConfigFor(
  mount: PodManifest['mounts'][number],
): Promise<Record<string, unknown>> {
  const zen = await import('@zenfs/core');
  const { source } = mount;

  let base: Record<string, unknown>;
  switch (source.kind) {
    case 'hostDir': {
      if (!isNode) {
        throw new Error(
          `realizeZenFs: mount '${mount.name}' is a hostDir — browsers have no host directories; ` +
            'use a backend source here and sync the pod to a server for hostDir/docker execution',
        );
      }
      const nodeFs = await import('node:fs');
      base = { backend: zen.Passthrough, fs: nodeFs, prefix: source.dir };
      break;
    }
    case 'backend': {
      if (source.backend === 'memory') {
        base = { backend: zen.InMemory, label: `artipod-${mount.name}` };
      } else if (source.backend === 'indexeddb') {
        const dom = await import('@zenfs/dom');
        base = { backend: dom.IndexedDB, storeName: `artipod-${mount.name}` };
      } else {
        const dom = await import('@zenfs/dom');
        if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
          throw new Error(`realizeZenFs: mount '${mount.name}' wants OPFS, which this environment lacks`);
        }
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(`artipod-${mount.name}`, { create: true });
        base = { backend: dom.WebAccess, handle: dir };
      }
      break;
    }
    case 'volume':
      throw new Error(
        `realizeZenFs: mount '${mount.name}' is an OCI volume ('${source.ref}') — volumes land with the OCI store (Phase 4)`,
      );
  }

  if (mount.mode === 'cow') {
    // Writes stay in the upper; the source is never touched.
    return { backend: (zen as { CopyOnWrite: unknown }).CopyOnWrite, readable: base, writable: { backend: zen.InMemory } };
  }
  return base;
}

export interface ZenFsRealization {
  zfs: ZenFsLike;
  mountTable: RealizedZenFsMount[];
}

/**
 * Realize the manifest's mounts onto the shared ZenFS singleton of this
 * package instance and return it with the mount table.
 */
export async function realizeZenFs(manifest: PodManifest): Promise<ZenFsRealization> {
  const m = validateManifest(manifest);
  if (m.root) {
    throw new Error('realizeZenFs: manifest.root (OCI image roots) lands with the OCI store (Phase 4)');
  }
  const zen = await import('@zenfs/core');
  const zfs = zen.fs;

  for (const mount of m.mounts) {
    const config = await mountConfigFor(mount);
    const resolved = await zen.resolveMountConfig(config as never);
    if (mount.path !== '/') {
      await zfs.promises.mkdir(mount.path, { recursive: true });
    } else {
      try {
        zen.umount('/');
      } catch {
        // nothing mounted at root yet
      }
    }
    zen.mount(mount.path, resolved);
  }

  return { zfs, mountTable: m.mounts.map((x) => ({ name: x.name, path: x.path, readonly: x.mode === 'ro' })) };
}

export interface ZenFsPodOptions
  extends Pick<
    CreateSandboxOptions,
    'onEdit' | 'extraCommands' | 'hooks' | 'executionLimits' | 'executionLimitProfile'
  > {
  /**
   * Adopt an fs the host already configured (e.g. artipod-sync's
   * initFileSystem with backend selection + migration + multi-tab guard):
   * the manifest then DESCRIBES the existing layout instead of mounting it.
   * rw/cow mount paths are created if missing; nothing is (re)mounted.
   */
  adopt?: ZenFsLike;
  events?: PodEvents;
  /** Mount /proc with the pod provider + builtins in sandboxes. Default true. */
  proc?: boolean;
  /** Shell cwd. Default: the first mount's path. */
  cwd?: string;
  /** OCI layer: transport for `artipod image pull` (store always available). */
  oci?: { transport?: OciTransport };
  /** `artipod publish [<name:tag>]` handler (app-provided — see docs/sync.md). */
  publish?: (target?: string) => Promise<string>;
  /** Manager sync: the remote PodStore push/pull/clone talk to. */
  sync?: {
    remote?: import('../manager/pod-store.js').PodStore;
    /**
     * Open this published ref as the workspace basis at boot (sync plan
     * Phase D): index pull if needed → lazy view → writable CoW overlay at
     * `at` (default /open/<ref-slug>); default cwd moves there.
     */
    basis?: {
      ref: string;
      at?: string;
      /** ZenFS mount config for the overlay upper (default: InMemory). Pass a persistent backend for cow forks. */
      upperConfig?: unknown;
    };
    /** LWW identity on pushed layers (Decision D8). Default: random per boot. */
    actor?: string;
    /**
     * Debounced overlay write-back (sync plan Phase E, Decision D7): after
     * a quiet window every workspace change pushes as appended per-file
     * layers (rm → whiteouts). Default ON when basis + remote are set.
     */
    autoPush?: boolean | { debounceMs?: number };
  };
  /**
   * Phase 6.5 (docs/encryption.md + docs/security-model.md): encrypt the
   * pod's store with keyring custody and wire login/lock + the sudo
   * approval flow. `login` is app-provided (it crosses an authenticated
   * channel in real deployments).
   */
  authority?: {
    login: () => Promise<import('../manager/authority.js').LoginResult | import('../manager/authority.js').KeyedLoginResult>;
    /** Encrypt this pod's blobs; reads while locked fail EACCES. */
    encrypt?: boolean;
    /**
     * Adopt an already-established session at boot, BEFORE any store I/O
     * (a basis open must land encrypted): the key enters the keyring under
     * THIS pod's id with the lease's expiry. Typical source: a broker
     * `/api/keys/login` unwrapped via `unwrapLoginResult`.
     */
    adopt?: { lease: import('../manager/authority.js').Lease; key: CryptoKey };
    lockMode?: import('../manager/locker.js').LockMode;
    /** Signed admin policy enabling the sudo approval flow. */
    policy?: import('../manager/policy.js').AdminPolicy;
    /** The human approval channel (console/panel). */
    prompt?: import('../manager/approval.js').ApprovalPrompt;
    /** Requesting principal for sudo. Default `agent:pod`. */
    principal?: string;
  };
  /**
   * Phase 6.6: lazy hydration. Present = the pod gets a Hydrator (index
   * pulls, hydrate/dehydrate verbs, /proc/hydration, agent prefetch tool).
   */
  hydration?: {
    policy?: HydrationPolicy;
    /** Default image ref for the agent's prefetch tool. */
    defaultRef?: string;
    /** Dehydrated READ behavior: 'fail' (default, zero-fetch pinned) or 'fetch' (sync plan D6). */
    onDemand?: 'fail' | 'fetch';
  };
}

export interface ZenFsPod {
  readonly manifest: PodManifest;
  readonly zfs: ZenFsLike;
  readonly events: PodEvents;
  readonly mountTable: ReadonlyArray<RealizedZenFsMount>;
  /** The pod's OCI blob store (initialized on first use). */
  readonly oci: { store: OciStore; transport?: OciTransport };
  /** Pod revision control: snapshots, checkout, commit, compact, gc. */
  readonly snapshots: SnapshotManager;
  /** Phase 6.5: session keyring / lock lifecycle / provenance (always present). */
  readonly keyring: Keyring;
  readonly locker: PodLocker;
  readonly audit: AuditLog;
  /** Present when `authority.policy` is configured. */
  readonly approvals?: ApprovalBroker;
  /** Present when `hydration` is configured (Phase 6.6). */
  readonly hydrator?: Hydrator;
  /** Present when `sync.basis` opened at boot (sync plan Phase D). */
  readonly basis?: { ref: string; at: string };
  /** Push the overlay's changes now (the auto-push path, awaitable). */
  pushBasis(): Promise<import('../manager/overlay-sync.js').OverlayPushResult | null>;
  /**
   * Loop options implementing the default-ON agent auto-snapshot (plan
   * Decision #5): a diff snapshot lands before every tool-executing turn;
   * pass `{ autoSnapshot: false }` to opt out. Spread into loop.run options.
   */
  agentLoopOptions(opts?: { autoSnapshot?: boolean }): Pick<ToolCallingLoopOptions, 'beforeToolTurn'>;
  /** just-bash session over the realized fs, pod commands + /proc registered. */
  /**
   * A shell over the pod. `confineTo` roots the shell at that path (other
   * workspaces and pod internals become unreachable — shell-level, not a
   * security boundary); cwd becomes '/' and /proc is off inside it.
   */
  createSandbox(opts?: { confineTo?: string }): Sandbox;
  /** VS Code-schema file tools resolved over the pod's mount table. */
  createFileTools(): ToolHandler[];
  /** Agent tool map (bash + file tools) for a sandbox of this pod. */
  createAgentTools(sandbox: Sandbox): Map<string, AgentToolHandler>;
  dispose(): void;
}

export async function createZenFsPod(
  manifest: PodManifest,
  options: ZenFsPodOptions = {},
): Promise<ZenFsPod> {
  const m = validateManifest(manifest);
  const events = options.events ?? new PodEvents();
  const proc = options.proc ?? true;
  // captured for the sync createSandbox (bindContext-based confinement)
  const zen = await import('@zenfs/core');

  let zfs: ZenFsLike;
  let mountTable: RealizedZenFsMount[];
  if (options.adopt) {
    zfs = options.adopt;
    mountTable = m.mounts.map((x) => ({ name: x.name, path: x.path, readonly: x.mode === 'ro' }));
    for (const mount of mountTable) {
      if (!mount.readonly && mount.path !== '/') {
        await zfs.promises.mkdir(mount.path, { recursive: true });
      }
    }
  } else {
    ({ zfs, mountTable } = await realizeZenFs(m));
  }

  const disposeProc = proc ? registerPodManifestProvider(m) : null;
  let defaultCwd = options.cwd ?? mountTable[0]?.path ?? '/';

  const ociStore = new OciStore(zfs);
  await ociStore.init();
  const oci = { store: ociStore, transport: options.oci?.transport };
  const snapshots = new SnapshotManager({
    zfs,
    store: ociStore,
    roots: mountTable.filter((e) => !e.readonly).map((e) => e.path),
  });

  // Phase 6.5: keyring custody, lock lifecycle, provenance, approvals.
  const keyring = new Keyring();
  const audit = new AuditLog(ociStore);
  const podId = ociStore.getSuperblock().podId;
  const locker = new PodLocker({
    keyring,
    stores: new Map([[podId, ociStore]]),
    audit,
    mode: options.authority?.lockMode,
  });
  if (options.authority?.encrypt) await locker.bind(podId);
  if (options.authority?.adopt) {
    await locker.adoptLease(options.authority.adopt.lease, { [podId]: options.authority.adopt.key });
  }
  const approvals = options.authority?.policy
    ? new ApprovalBroker({ policy: options.authority.policy, keyring, events, audit, prompt: options.authority.prompt })
    : undefined;
  const authorityContext = options.authority
    ? { login: options.authority.login, locker, keyring }
    : undefined;
  let disposeKeysProc: (() => void) | null = null;
  if (proc) {
    try {
      disposeKeysProc = registerProcProvider(makeKeysProcProvider(keyring));
    } catch {
      // another live pod already projects /proc/keys; that one wins
    }
  }

  // Phase 6.6: lazy hydration.
  const hydrator = options.hydration
    ? new Hydrator({
        store: ociStore,
        zfs,
        remote: options.sync?.remote,
        transport: options.oci?.transport,
        events,
        policy: options.hydration.policy,
        onDemand: options.hydration.onDemand,
      })
    : undefined;
  let disposeHydrationProc: (() => void) | null = null;
  if (proc && hydrator) {
    try {
      disposeHydrationProc = registerProcProvider(hydrator.procProvider());
    } catch {
      // already projected by another live pod
    }
  }

  // Sync plan Phase D: open the published basis as the workspace.
  let basis: { ref: string; at: string } | undefined;
  if (options.sync?.basis && hydrator) {
    const { ref } = options.sync.basis;
    const at = options.sync.basis.at ?? `/open/${ref.replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
    try {
      // Same rule as the `artipod open` verb: refresh when the remote head
      // moved — a stale local index would open yesterday's (possibly empty)
      // tree while the server already holds newer layers.
      const state = await hydrator.stateFor(ref);
      const remoteHead = options.sync.remote ? await options.sync.remote.getRef(ref).catch(() => null) : null;
      if (!state || (remoteHead && remoteHead.manifestDigest !== state.manifestDigest)) {
        await hydrator.pullIndex(ref);
      }
      await hydrator.openOverlay(ref, at, { upperConfig: options.sync.basis.upperConfig });
      basis = { ref, at };
      if (!options.cwd) defaultCwd = at;
    } catch (e) {
      // the pod still boots offline — the basis can be opened later via the verb
      console.warn(`artipod: basis '${ref}' not opened — ${(e as Error).message}`);
    }
  }

  // Sync plan Phase E: debounced overlay write-back.
  const actor = options.sync?.actor ?? `actor:${Math.random().toString(36).slice(2, 10)}`;
  const autoPushOpt = options.sync?.autoPush;
  const debounceMs = typeof autoPushOpt === 'object' ? (autoPushOpt.debounceMs ?? 2000) : 2000;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let pushing = false;
  let pushQueued = false;
  const pushBasis = async () => {
    const remote = options.sync?.remote;
    if (!basis || !hydrator || !remote) return null;
    if ((await import('../oci/settings.js').then((m) => m.readPodSettings(zfs))).offline) {
      events.emit('sync:push', { ref: basis.ref, ok: false, layers: 0, movedBytes: 0, error: "offline mode is on ('artipod offline off' to re-enable)" });
      return null;
    }
    const overlay = hydrator.overlays.get(basis.ref);
    if (!overlay) return null;
    if (pushing) {
      pushQueued = true;
      return null;
    }
    pushing = true;
    try {
      const result = await pushOverlay({
        store: ociStore,
        zfs,
        ref: basis.ref,
        upperAt: overlay.upperAt,
        deletions: hydrator.overlayDeletions(basis.ref),
        actor,
        remote,
      });
      if (result.pushed) {
        events.emit('sync:push', { ref: basis.ref, ok: true, layers: result.overlayLayers, movedBytes: result.sync?.movedBytes ?? 0 });
      }
      return result;
    } catch (e) {
      console.warn(`artipod: overlay push for '${basis.ref}' failed — ${(e as Error).message}`);
      events.emit('sync:push', { ref: basis.ref, ok: false, layers: 0, movedBytes: 0, error: (e as Error).message });
      return null;
    } finally {
      pushing = false;
      if (pushQueued) {
        pushQueued = false;
        schedulePush();
      }
    }
  };
  const schedulePush = () => {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void pushBasis(), debounceMs);
  };
  const autoPushOn = basis && options.sync?.remote && autoPushOpt !== false;
  const offAutoPush = autoPushOn ? events.on('fs:changed', schedulePush) : null;

  const podFs = zfs.promises as unknown as PodFs;
  const resolver = () =>
    new PodPathResolver(
      mountTable.map((e) => ({
        path: e.path,
        mount: new ArtiMount(e.name, e.path, e.readonly, podFs),
      })),
    );

  return {
    manifest: m,
    zfs,
    events,
    mountTable,
    oci,    snapshots,
    keyring,
    locker,
    audit,
    approvals,
    hydrator,
    basis,
    pushBasis,
    agentLoopOptions(opts?: { autoSnapshot?: boolean }) {
      if (opts?.autoSnapshot === false) return {};
      return {
        beforeToolTurn: async () => {
          await snapshots.create({ origin: 'agent-turn', skipIfClean: true });
        },
      };
    },    createSandbox(sandboxOpts?: { confineTo?: string }) {
      // Shell-level confinement (same bindContext the session host uses for
      // chroots): the shell sees confineTo as '/', so other workspaces and
      // pod internals are out of reach. Courtesy isolation, not security —
      // the artipod verbs still operate on the whole pod.
      const confineTo = sandboxOpts?.confineTo;
      const shellZfs = confineTo
        ? ((zen as unknown as { bindContext: (o: { root: string }) => { fs: unknown } }).bindContext({ root: confineTo })
            .fs as typeof zfs)
        : zfs;
      const sandbox: Sandbox = createSandbox({
        zfs: shellZfs,
        events,
        proc: confineTo ? false : proc,
        cwd: confineTo ? '/' : defaultCwd,
        onEdit: options.onEdit && confineTo
          ? (path) => options.onEdit!(`${confineTo}${path.startsWith('/') ? '' : '/'}${path}`)
          : options.onEdit,
        sudo: approvals
          ? {
              broker: approvals,
              principal: options.authority?.principal ?? 'agent:pod',
              execute: (command) => sandbox.exec(command),
            }
          : undefined,
        extraCommands: [
          makeArtipodCommand({
            store: ociStore,
            zfs,
            transport: options.oci?.transport,
            events,
            snapshots,
            remote: options.sync?.remote,
            authority: authorityContext,
            hydrator,
            pushBasis,
            publish: options.publish,
          }),
          ...(options.extraCommands ?? []),
        ],
        hooks: options.hooks,
        executionLimits: options.executionLimits,
        executionLimitProfile: options.executionLimitProfile,
      });
      return sandbox;
    },
    createFileTools() {
      return createPodFileTools(resolver());
    },
    createAgentTools(sandbox: Sandbox) {
      const tools = createSandboxTools(sandbox, {
        mounts: mountTable.map((e) => ({ name: e.name, path: e.path, readonly: e.readonly })),
      });
      if (hydrator) {
        tools.set('prefetch', makePrefetchTool(hydrator, options.hydration?.defaultRef) as never);
      }
      return tools;
    },
    dispose() {
      if (pushTimer) clearTimeout(pushTimer);
      offAutoPush?.();
      // Unmount overlays — a later session must not read this one's stale view.
      if (hydrator) for (const ref of [...hydrator.overlays.keys()]) hydrator.closeOverlay(ref);
      disposeProc?.();
      disposeKeysProc?.();
      disposeHydrationProc?.();
    },
  };
}
