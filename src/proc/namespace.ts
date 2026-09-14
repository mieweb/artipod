/**
 * A namespace (Decisions D16/D18) — THE object a shell reads its world from,
 * and the same object `/proc` projects as files:
 *
 *   identity   → uname / hostname / prompt      ↔ /proc/sys/kernel/*
 *   processes  → ps / kill                      ↔ /proc/<pid>/status
 *   inventory  → images / volumes / artipod …   ↔ /proc/images, /proc/workspaces
 *
 * Whoever owns the PID namespace owns this (a pod via `createZenFsPod`, or
 * `openConsole()` for pod-less shells); it is the ONLY caller of the global
 * `/proc` registrations and tears them down in one `dispose()`.
 */
import type { SandboxIdentity } from './identity.js';
import { makeIdentityProvider } from './identity.js';
import type { InventoryProviders } from './inventory.js';
import { makeInventoryProvider } from './inventory.js';
import { ProcessTable, registerProcessTable } from './processes.js';
import { getProvider, registerProcProvider } from './registry.js';
import type { ProcProvider } from './registry.js';

export interface NamespaceOptions {
  /** Names the namespace: pid 1, `hostname`, `uname`. */
  identity: SandboxIdentity;
  /** Adopt a caller-owned table (tests); it is registered but not disposed here. */
  processes?: ProcessTable;
  inventory?: InventoryProviders;
  /** Project into the global `/proc` registry. Default true; false for shells without /proc. */
  proc?: boolean;
}

export interface Namespace {
  readonly identity: SandboxIdentity;
  readonly processes: ProcessTable;
  readonly inventory?: InventoryProviders;
  /** Unregisters the `/proc` projection synchronously, then cascades KILL through the owned table. */
  dispose(): Promise<void>;
}

const unregisterBy = new WeakMap<ProcProvider, () => void>();

/** Latest live namespace wins the global `/proc/<name>` slot; a stale owner's unregister is a no-op. */
function registerLatest(provider: ProcProvider): () => void {
  const previous = getProvider(provider.name);
  if (previous) unregisterBy.get(previous.provider)?.();
  const off = registerProcProvider(provider);
  unregisterBy.set(provider, off);
  return () => {
    unregisterBy.delete(provider);
    off();
  };
}

export function openNamespace(opts: NamespaceOptions): Namespace {
  const owned = !opts.processes;
  const processes = opts.processes ?? new ProcessTable(opts.identity.name);
  const offs: Array<() => void> = [];
  if (opts.proc !== false) {
    offs.push(registerLatest(makeIdentityProvider(opts.identity)));
    offs.push(registerProcessTable(processes));
    if (opts.inventory) offs.push(registerLatest(makeInventoryProvider(opts.inventory)));
  }
  let disposed = false;
  return {
    identity: opts.identity,
    processes,
    inventory: opts.inventory,
    dispose() {
      if (disposed) return Promise.resolve();
      disposed = true;
      for (const off of offs.splice(0)) off();
      return owned ? processes.dispose() : Promise.resolve();
    },
  };
}
