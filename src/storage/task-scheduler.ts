/**
 * TaskScheduler (spa-ui-plan P10/D2): every background timer in the app —
 * key renewal, push retry, verdict refresh — is a NAMED task with
 * introspectable state. The task table is the substrate for `artipod ps`
 * (wired to the shell as a proc provider in U3) and replaces the old app's
 * anonymous setTimeout closures.
 */

export type TaskState = 'idle' | 'scheduled' | 'running';

export interface TaskSnapshot {
  name: string;
  state: TaskState;
  /** epoch ms, when scheduled. */
  nextRunAt?: number;
  /** epoch ms of the last completed run. */
  lastRunAt?: number;
  lastResult?: 'ok' | 'error';
  lastError?: string;
  /** Recurring interval, if registered with one. */
  everyMs?: number;
}

interface Task {
  fn: () => Promise<void> | void;
  everyMs?: number;
  timer: ReturnType<typeof setTimeout> | null;
  snap: TaskSnapshot;
}

export class TaskScheduler {
  private tasks = new Map<string, Task>();
  private listeners = new Set<() => void>();

  constructor(private now: () => number = Date.now) {}

  /** Define (or redefine) a task. `everyMs` re-arms after every run; `startNow` schedules immediately. */
  register(name: string, fn: () => Promise<void> | void, opts: { everyMs?: number; startNow?: boolean } = {}): void {
    const existing = this.tasks.get(name);
    if (existing?.timer) clearTimeout(existing.timer);
    this.tasks.set(name, {
      fn,
      everyMs: opts.everyMs,
      timer: null,
      snap: { name, state: 'idle', everyMs: opts.everyMs, ...existing?.snap, nextRunAt: undefined },
    });
    if (opts.startNow) this.schedule(name, 0);
    else this.notify();
  }

  /** (Re)arm a one-shot run `delayMs` from now (replaces any pending arm). */
  schedule(name: string, delayMs: number): void {
    const task = this.tasks.get(name);
    if (!task) throw new Error(`unknown task: ${name}`);
    if (task.timer) clearTimeout(task.timer);
    task.snap.state = 'scheduled';
    task.snap.nextRunAt = this.now() + delayMs;
    task.timer = setTimeout(() => void this.run(name), delayMs);
    this.notify();
  }

  /** Run now (manual or timer-fired). Recurring tasks re-arm afterwards. */
  async run(name: string): Promise<void> {
    const task = this.tasks.get(name);
    if (!task || task.snap.state === 'running') return;
    if (task.timer) clearTimeout(task.timer);
    task.timer = null;
    task.snap.state = 'running';
    task.snap.nextRunAt = undefined;
    this.notify();
    try {
      await task.fn();
      task.snap.lastResult = 'ok';
      task.snap.lastError = undefined;
    } catch (err) {
      task.snap.lastResult = 'error';
      task.snap.lastError = err instanceof Error ? err.message : String(err);
    }
    task.snap.lastRunAt = this.now();
    task.snap.state = 'idle';
    if (task.everyMs !== undefined && this.tasks.get(name) === task) this.schedule(name, task.everyMs);
    else this.notify();
  }

  cancel(name: string): void {
    const task = this.tasks.get(name);
    if (!task) return;
    if (task.timer) clearTimeout(task.timer);
    task.timer = null;
    task.snap.state = 'idle';
    task.snap.nextRunAt = undefined;
    this.notify();
  }

  /** The `artipod ps` table. */
  list(): TaskSnapshot[] {
    return Array.from(this.tasks.values(), (t) => ({ ...t.snap }));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    for (const name of this.tasks.keys()) this.cancel(name);
    this.tasks.clear();
    this.listeners.clear();
  }

  private notify(): void {
    this.listeners.forEach((l) => l());
  }
}
