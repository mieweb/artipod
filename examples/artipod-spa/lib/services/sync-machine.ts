/**
 * The push-retry state machine (spa-ui-plan U1: the pure heart of
 * PodSessionService, extracted from the old app's 400-line effect closure).
 * Deterministic reducer — timers/network live outside (TaskScheduler task
 * `sync:push` in U3); the reducer answers "what now?" so it can be tested
 * exhaustively without a browser.
 */

export type SyncPhase =
  | 'clean' // nothing to push
  | 'dirty' // local writes waiting for the debounce
  | 'pushing' // a push is in flight
  | 'synced' // last push landed; nothing since
  | 'failed'; // last push failed — local is ahead (retry on boot/reconnect/interval)

export type SyncEvent =
  | { type: 'edit' } // fs write in the workspace
  | { type: 'push-start' }
  | { type: 'push-ok'; at: number }
  | { type: 'push-fail' }
  | { type: 'retry-tick' } // boot probe, reconnect, or the 15s interval
  | { type: 'offline' } // forced offline (or the network died)
  | { type: 'online' };

export interface SyncState {
  phase: SyncPhase;
  /** Writes arrived while a push was already in flight — push again after. */
  dirtyDuringPush: boolean;
  /** epoch ms of the last landed push. */
  lastPushedAt?: number;
  offline: boolean;
}

export const initialSyncState: SyncState = { phase: 'clean', dirtyDuringPush: false, offline: false };

export function reduceSync(state: SyncState, event: SyncEvent): SyncState {
  switch (event.type) {
    case 'edit':
      return state.phase === 'pushing' ? { ...state, dirtyDuringPush: true } : { ...state, phase: 'dirty' };
    case 'push-start':
      return { ...state, phase: 'pushing', dirtyDuringPush: false };
    case 'push-ok':
      return state.dirtyDuringPush
        ? { ...state, phase: 'dirty', dirtyDuringPush: false, lastPushedAt: event.at }
        : { ...state, phase: 'synced', lastPushedAt: event.at };
    case 'push-fail':
      return { ...state, phase: 'failed', dirtyDuringPush: false };
    case 'retry-tick':
      return state;
    case 'offline':
      return { ...state, offline: true };
    case 'online':
      return { ...state, offline: false };
  }
}

/** Should this event trigger a push attempt right now? */
export function wantsPush(state: SyncState, event: SyncEvent): boolean {
  if (state.offline && event.type !== 'online') return false;
  switch (event.type) {
    case 'edit':
      return state.phase !== 'pushing'; // (debounced by the caller)
    case 'retry-tick':
    case 'online':
      return state.phase === 'failed' || state.phase === 'dirty';
    case 'push-ok':
      return state.dirtyDuringPush; // writes raced the push — go again
    default:
      return false;
  }
}
