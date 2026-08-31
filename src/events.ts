/**
 * pod.events — the coherence bus for everything operating on one pod
 * (plan §3 "Browser UI surfaces"). Shell, tools, editor, tree and agent all
 * see the same store; these events keep them in sync without polling.
 *
 * fs invalidation is command-boundary coarse BY CONTRACT (a bash line can
 * touch anything): after every live exec a coarse `fs:changed` fires. Do not
 * rely on ZenFS `fs.watch`.
 */

export interface ExecStartEvent {
  line: string;
}

export interface ExecEndEvent {
  line: string;
  exitCode: number;
  durationMs: number;
}

export interface FsChangedEvent {
  /**
   * Affected paths when precisely known (tool edits, editor saves);
   * undefined = coarse "anything may have changed" (after a shell command).
   */
  paths?: string[];
  origin: 'exec' | 'tool' | 'editor' | 'git' | 'agent' | 'external';
}

export interface EditRequestEvent {
  path: string;
}

export interface AgentToolCallEvent {
  phase: 'call' | 'result';
  name: string;
  /** Raw JSON argument string as the model sent it. */
  arguments: string;
  id?: string;
  /** Result phase only. */
  ok?: boolean;
  summary?: string;
}

export interface ApprovalRequestEvent {
  verb: string;
  target?: string;
  justification?: string;
  /** Phase 6.5 approval flow: who is asking, for exactly what. */
  principal?: string;
  capability?: { class: string; mode?: string; ttlMs?: number };
  command?: string;
}

/** Phase 6.6 hydration transfers (docs: browser.md §hydration). */
export interface FetchStartEvent {
  digest: string;
  lane: 'interactive' | 'prefetch' | 'background';
  size?: number;
}

export interface FetchProgressEvent {
  digest: string;
  received: number;
  total?: number;
}

export interface FetchDoneEvent {
  digest: string;
  ok: boolean;
  bytes: number;
}

export interface PodEventMap {
  'exec:start': ExecStartEvent;
  'exec:end': ExecEndEvent;
  'fs:changed': FsChangedEvent;
  'edit:request': EditRequestEvent;
  'agent:tool-call': AgentToolCallEvent;
  'approval:request': ApprovalRequestEvent;
  'fetch:start': FetchStartEvent;
  'fetch:progress': FetchProgressEvent;
  'fetch:done': FetchDoneEvent;
}

export type PodEventName = keyof PodEventMap;

type AnyListener = (payload: never) => void;

export class PodEvents {
  private listeners = new Map<PodEventName, Set<AnyListener>>();

  /** Subscribe; returns the unsubscribe function. */
  on<K extends PodEventName>(event: K, listener: (payload: PodEventMap[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as AnyListener);
    return () => this.off(event, listener);
  }

  off<K extends PodEventName>(event: K, listener: (payload: PodEventMap[K]) => void): void {
    this.listeners.get(event)?.delete(listener as AnyListener);
  }

  emit<K extends PodEventName>(event: K, payload: PodEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (p: PodEventMap[K]) => void)(payload);
      } catch (error) {
        // A misbehaving listener must never take down the emitter.
        console.error(`pod.events listener for '${event}' threw:`, error);
      }
    }
  }

  listenerCount(event: PodEventName): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
