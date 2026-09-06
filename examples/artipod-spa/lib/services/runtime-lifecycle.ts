import { parseRuntimeTelemetry, type RuntimeTelemetry } from './runtime-telemetry';

export type LifecycleState = 'unknown' | 'unsupported' | 'running' | 'suspending' | 'suspended' | 'resuming' | 'error';

export interface LifecycleSnapshot {
  state: LifecycleState;
  error?: string;
  telemetry?: RuntimeTelemetry;
}

export interface LifecycleController {
  suspend(): void;
  resume(): void;
  dispose(): void;
}

const READY = 'artipod:runtime-lifecycle/v1/ready';
const ACK = 'artipod:runtime-lifecycle/v1/ack';
const QUERY = 'artipod:runtime-lifecycle/v1/query';
const REQUEST = 'artipod:runtime-lifecycle/v1/request';
const REQUEST_TIMEOUT_MS = 5000;

// Cooperative protocol: the app must acknowledge before the host reports it suspended.
export function controlRuntimeLifecycle(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  origin: string,
  source: () => Window | null,
  report: (value: LifecycleSnapshot) => void,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = globalThis,
): LifecycleController {
  let snapshot: LifecycleSnapshot = { state: 'unknown' };
  let pending: { id: string; command: 'suspend' | 'resume'; timer: ReturnType<typeof setTimeout> } | undefined;
  let disposed = false;
  const emit = (next: LifecycleSnapshot) => { snapshot = next; if (!disposed) report(next); };
  const clearPending = () => { if (pending) timers.clearTimeout(pending.timer); pending = undefined; };
  const post = (message: Record<string, unknown>) => {
    const current = source();
    if (!current) return false;
    try { current.postMessage(message, origin); return true; } catch { return false; }
  };
  const receive = (event: MessageEvent) => {
    const current = source();
    if (!current || event.source !== current || event.origin !== origin) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === READY) {
      if (snapshot.state !== 'unknown' && snapshot.state !== 'unsupported') return;
      emit({ state: data.state === 'suspended' ? 'suspended' : 'running', telemetry: parseRuntimeTelemetry(data.telemetry) ?? undefined });
      return;
    }
    if (data.type !== ACK || !pending || data.id !== pending.id) return;
    const { command } = pending;
    clearPending();
    if (data.state !== (command === 'suspend' ? 'suspended' : 'running')) {
      emit({ state: 'error', error: `Application did not confirm ${command}` });
      return;
    }
    emit({ state: data.state, telemetry: parseRuntimeTelemetry(data.telemetry) ?? undefined });
  };
  const request = (command: 'suspend' | 'resume') => {
    if (pending || disposed) return;
    const from = command === 'suspend' ? 'running' : 'suspended';
    if (snapshot.state !== from) return;
    const id = crypto.randomUUID();
    const timer = timers.setTimeout(() => {
      pending = undefined;
      emit({ state: 'error', error: `Application did not respond to ${command}` });
    }, REQUEST_TIMEOUT_MS);
    pending = { id, command, timer };
    emit({ state: command === 'suspend' ? 'suspending' : 'resuming', telemetry: snapshot.telemetry });
    if (!post({ type: REQUEST, id, command })) {
      clearPending();
      emit({ state: 'error', error: 'Application frame unavailable' });
    }
  };
  target.addEventListener('message', receive);
  const probe = timers.setTimeout(() => { if (snapshot.state === 'unknown') emit({ state: 'unsupported' }); }, REQUEST_TIMEOUT_MS);
  post({ type: QUERY });
  return {
    suspend: () => request('suspend'),
    resume: () => request('resume'),
    dispose() {
      disposed = true;
      clearPending();
      timers.clearTimeout(probe);
      target.removeEventListener('message', receive);
    },
  };
}
