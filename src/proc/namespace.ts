/**
 * A process namespace (Decision D16/D18): the ProcessTable plus its `/proc`
 * projection and, optionally, an inventory provider. Whoever owns the
 * namespace (a pod, or `openConsole()` for pod-less shells) is the ONLY
 * caller of the global registrations, and tears them down in one place.
 */
import type { InventoryProviders } from './inventory.js';
import { makeInventoryProvider } from './inventory.js';
import { ProcessTable, registerProcessTable } from './processes.js';
import { getProvider, registerProcProvider } from './registry.js';
import type { ProcProvider } from './registry.js';

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

export interface NamespaceOptions {
  /** pid 1's name — the identity name (`<ref>`, `<podId>`, `catalog`, `<sessionId>`). */
  name: string;
  /** Adopt a caller-owned table (tests); it is registered but not disposed here. */
  processes?: ProcessTable;
  inventory?: InventoryProviders;
  /** Project into the global `/proc` registry. Default true; false for shells without /proc. */
  proc?: boolean;
}

export interface Namespace {
  readonly processes: ProcessTable;
  readonly inventory?: InventoryProviders;
  /** Unregisters `/proc` rows synchronously, then cascades KILL through the owned table. */
  dispose(): Promise<void>;
}

export function openNamespace(opts: NamespaceOptions): Namespace {
  const owned = !opts.processes;
  const processes = opts.processes ?? new ProcessTable(opts.name);
  const offs: Array<() => void> = [];
  if (opts.proc !== false) {
    offs.push(registerProcessTable(processes));
    if (opts.inventory) offs.push(registerLatest(makeInventoryProvider(opts.inventory)));
  }
  let disposed = false;
  return {
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
