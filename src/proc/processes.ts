/**
 * The process table: what is running inside one supervisor (a pod session,
 * a serve instance, …), shaped like a PID namespace.
 *
 * pid 1 is the supervisor itself. Everything it launches — shells, admitted
 * browser apps, background tasks — is a row here. Visibility is downward
 * only: a shell sees its own namespace, never a parent tab or the server.
 * pids are namespace-local; `id` is the stable identity (uuid) a row keeps
 * across tables. Signals are per-kind and cooperative: a row with no handler
 * for a signal answers `ENOTSUP` rather than pretending.
 */
import { registerProcProvider, type ProcProvider, type ProcTree } from './registry.js';

export type ProcessKind = 'init' | 'shell' | 'app' | 'task';
export type ProcessSignal = 'STOP' | 'CONT' | 'TERM' | 'KILL';
export const PROCESS_SIGNALS: readonly ProcessSignal[] = ['STOP', 'CONT', 'TERM', 'KILL'];

export interface ProcessInfo {
  pid: number;
  ppid: number;
  id: string;
  kind: ProcessKind;
  name: string;
  state: string;
  /** epoch ms */
  startedAt: number;
  /** Free-form, kind-specific columns (mode, digest, url, …). Strings only. */
  detail: Readonly<Record<string, string>>;
  /** Signals this row will act on. */
  signals: readonly ProcessSignal[];
}

export interface ProcessSpec {
  kind: Exclude<ProcessKind, 'init'>;
  name: string;
  state?: string;
  detail?: Record<string, string>;
  /** Defaults to pid 1. */
  ppid?: number;
  /** Stable identity; defaults to a fresh uuid. */
  id?: string;
  /** Per-signal handlers. A missing signal → ENOTSUP. */
  signal?: Partial<Record<ProcessSignal, () => void | Promise<void>>>;
}

export interface ProcessHandle {
  readonly pid: number;
  readonly id: string;
  update(patch: { state?: string; detail?: Record<string, string> }): void;
  /** Removes the row. Idempotent. */
  exit(): void;
}

export class ProcessError extends Error {
  constructor(readonly code: 'ESRCH' | 'ENOTSUP' | 'EPERM', message: string) {
    super(message);
    this.name = 'ProcessError';
  }
}

interface Row extends Omit<ProcessInfo, 'detail' | 'signals'> {
  detail: Record<string, string>;
  handlers: Partial<Record<ProcessSignal, () => void | Promise<void>>>;
}

export class ProcessTable {
  private readonly rows = new Map<number, Row>();
  private readonly listeners = new Set<() => void>();
  private nextPid = 2;
  private disposed = false;

  constructor(name = 'artipod', private readonly now: () => number = Date.now) {
    this.rows.set(1, {
      pid: 1, ppid: 0, id: crypto.randomUUID(), kind: 'init', name, state: 'running',
      startedAt: this.now(), detail: {}, handlers: {},
    });
  }

  spawn(spec: ProcessSpec): ProcessHandle {
    if (this.disposed) throw new ProcessError('EPERM', 'process table disposed');
    const ppid = spec.ppid ?? 1;
    if (!this.rows.has(ppid)) throw new ProcessError('ESRCH', `no such parent process ${ppid}`);
    const pid = this.nextPid++;
    const row: Row = {
      pid, ppid, id: spec.id ?? crypto.randomUUID(), kind: spec.kind, name: spec.name,
      state: spec.state ?? 'running', startedAt: this.now(), detail: { ...spec.detail }, handlers: { ...spec.signal },
    };
    this.rows.set(pid, row);
    this.emit();
    return {
      pid,
      id: row.id,
      update: (patch) => {
        if (this.rows.get(pid) !== row) return;
        if (patch.state !== undefined) row.state = patch.state;
        if (patch.detail) Object.assign(row.detail, patch.detail);
        this.emit();
      },
      exit: () => {
        if (this.rows.get(pid) !== row) return;
        this.rows.delete(pid);
        this.emit();
      },
    };
  }

  list(): ProcessInfo[] {
    return [...this.rows.values()].sort((a, b) => a.pid - b.pid).map(view);
  }

  get(pid: number): ProcessInfo | undefined {
    const row = this.rows.get(pid);
    return row && view(row);
  }

  /** Delivers a signal; rejects with ProcessError ESRCH / ENOTSUP / EPERM. */
  async signal(pid: number, signal: ProcessSignal): Promise<void> {
    const row = this.rows.get(pid);
    if (!row) throw new ProcessError('ESRCH', `no such process ${pid}`);
    if (row.kind === 'init') throw new ProcessError('EPERM', 'pid 1 is the supervisor; close the session instead');
    const handler = row.handlers[signal];
    if (!handler) throw new ProcessError('ENOTSUP', `${row.kind} ${pid} does not handle ${signal}`);
    await handler();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Cascades KILL to every row that handles it, then empties the table. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const rows = [...this.rows.values()].filter((row) => row.kind !== 'init').reverse();
    for (const row of rows) {
      const handler = row.handlers.KILL ?? row.handlers.TERM;
      try { await handler?.(); } catch { /* best effort: the namespace is going away */ }
      this.rows.delete(row.pid);
    }
    this.emit();
    this.listeners.clear();
  }

  /** `/proc/<pid>/status` + `/proc/<pid>/cmdline` for every row. */
  provider(): ProcProvider {
    return {
      name: 'processes',
      description: 'Process table (ps / kill)',
      mode: 'ro',
      root: '',
      read: async (): Promise<ProcTree> => {
        const tree: ProcTree = {};
        for (const row of this.list()) {
          tree[`${row.pid}/status`] = status(row);
          tree[`${row.pid}/cmdline`] = `${row.kind}:${row.name}\n`;
        }
        return tree;
      },
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function view(row: Row): ProcessInfo {
  return {
    pid: row.pid, ppid: row.ppid, id: row.id, kind: row.kind, name: row.name, state: row.state,
    startedAt: row.startedAt, detail: { ...row.detail },
    signals: PROCESS_SIGNALS.filter((signal) => row.handlers[signal] !== undefined),
  };
}

function status(row: ProcessInfo): string {
  const lines = [
    `Name:\t${row.name}`, `Kind:\t${row.kind}`, `State:\t${row.state}`, `Pid:\t${row.pid}`, `PPid:\t${row.ppid}`,
    `Id:\t${row.id}`, `Started:\t${new Date(row.startedAt).toISOString()}`,
    `Signals:\t${row.signals.join(' ') || '-'}`,
    ...Object.entries(row.detail).map(([key, value]) => `${key[0].toUpperCase()}${key.slice(1)}:\t${value}`),
  ];
  return `${lines.join('\n')}\n`;
}

let unregisterCurrent: (() => void) | null = null;

/** Register (or replace) the process provider — one table per proc registry. */
export function registerProcessTable(table: ProcessTable): () => void {
  unregisterCurrent?.();
  const unregister = registerProcProvider(table.provider());
  unregisterCurrent = () => {
    unregister();
    unregisterCurrent = null;
  };
  return unregisterCurrent;
}
