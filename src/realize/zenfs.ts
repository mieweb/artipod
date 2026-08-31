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
}

export interface ZenFsPod {
  readonly manifest: PodManifest;
  readonly zfs: ZenFsLike;
  readonly events: PodEvents;
  readonly mountTable: ReadonlyArray<RealizedZenFsMount>;
  /** just-bash session over the realized fs, pod commands + /proc registered. */
  createSandbox(): Sandbox;
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
  const defaultCwd = options.cwd ?? mountTable[0]?.path ?? '/';

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
    createSandbox() {
      return createSandbox({
        zfs,
        events,
        proc,
        cwd: defaultCwd,
        onEdit: options.onEdit,
        extraCommands: options.extraCommands,
        hooks: options.hooks,
        executionLimits: options.executionLimits,
        executionLimitProfile: options.executionLimitProfile,
      });
    },
    createFileTools() {
      return createPodFileTools(resolver());
    },
    createAgentTools(sandbox: Sandbox) {
      return createSandboxTools(sandbox, {
        mounts: mountTable.map((e) => ({ name: e.name, path: e.path, readonly: e.readonly })),
      });
    },
    dispose() {
      disposeProc?.();
    },
  };
}
