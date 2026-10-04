import { describe, expect, it, vi } from 'vitest';
import { controlRuntimeLifecycle, type LifecycleSnapshot } from './lifecycle.js';

const ORIGIN = 'http://host.test';
function harness() {
  let listener: ((event: MessageEvent) => void) | undefined;
  const target = {
    addEventListener: vi.fn((_: string, callback: EventListenerOrEventListenerObject) => { listener = callback as (event: MessageEvent) => void; }),
    removeEventListener: vi.fn(() => { listener = undefined; }),
  };
  const sent: Record<string, unknown>[] = [];
  const frame = { postMessage: (data: Record<string, unknown>, origin: string) => { expect(origin).toBe(ORIGIN); sent.push(data); } } as unknown as Window;
  let current: Window | null = frame;
  const states: LifecycleSnapshot[] = [];
  const controller = controlRuntimeLifecycle(target, ORIGIN, () => current, value => states.push(value));
  const receive = (data: unknown, source: unknown = frame, origin = ORIGIN) => listener?.({ data, source, origin } as MessageEvent);
  const lastRequest = () => sent.at(-1) as { id: string; command: string };
  return { sent, states, controller, receive, lastRequest, detach: () => { current = null; }, attached: () => listener !== undefined };
}
const telemetry = { elapsedMs: 3000, retainedBytes: 49152, limitBytes: 8388608 };

describe('controlRuntimeLifecycle', () => {
  it('queries readiness, then suspends and resumes only with matching acknowledgements', () => {
    vi.useFakeTimers();
    const app = harness();
    expect(app.sent[0]).toEqual({ type: 'artipod:runtime-lifecycle/v1/query' });
    app.controller.suspend();
    expect(app.sent).toHaveLength(1);
    app.receive({ type: 'artipod:runtime-lifecycle/v1/ready', state: 'running', telemetry });
    expect(app.states.at(-1)).toEqual({ state: 'running', telemetry });
    app.controller.suspend();
    expect(app.states.at(-1)?.state).toBe('suspending');
    const { id } = app.lastRequest();
    expect(app.lastRequest().command).toBe('suspend');
    app.receive({ type: 'artipod:runtime-lifecycle/v1/ack', id: 'other', state: 'suspended', telemetry });
    app.receive({ type: 'artipod:runtime-lifecycle/v1/ack', id, state: 'suspended', telemetry }, {}, ORIGIN);
    app.receive({ type: 'artipod:runtime-lifecycle/v1/ack', id, state: 'suspended', telemetry }, undefined, 'http://evil.test');
    expect(app.states.at(-1)?.state).toBe('suspending');
    app.receive({ type: 'artipod:runtime-lifecycle/v1/ack', id, state: 'suspended', telemetry: { ...telemetry, retainedBytes: -1 } });
    expect(app.states.at(-1)).toEqual({ state: 'suspended', telemetry: undefined });
    app.controller.suspend();
    app.controller.resume();
    expect(app.lastRequest().command).toBe('resume');
    app.receive({ type: 'artipod:runtime-lifecycle/v1/ack', id: app.lastRequest().id, state: 'running', telemetry });
    expect(app.states.at(-1)).toEqual({ state: 'running', telemetry });
    app.controller.dispose();
    expect(app.attached()).toBe(false);
    vi.useRealTimers();
  });
  it('reports unsupported apps and unanswered requests without claiming suspension', () => {
    vi.useFakeTimers();
    const app = harness();
    vi.advanceTimersByTime(5000);
    expect(app.states.at(-1)).toEqual({ state: 'unsupported' });
    app.receive({ type: 'artipod:runtime-lifecycle/v1/ready', state: 'running' });
    app.controller.suspend();
    vi.advanceTimersByTime(5000);
    expect(app.states.at(-1)).toMatchObject({ state: 'error', error: 'Application did not respond to suspend' });
    app.controller.dispose();
    vi.useRealTimers();
  });
  it('re-queries on demand (iframe load): an app that missed the first query is not marked unsupported', () => {
    vi.useFakeTimers();
    const app = harness();
    vi.advanceTimersByTime(4000);
    app.controller.query(); // the frame just finished loading
    expect(app.sent.filter((m) => m.type === 'artipod:runtime-lifecycle/v1/query')).toHaveLength(2);
    vi.advanceTimersByTime(2000); // 6s after the first query, 2s after the second
    expect(app.states.at(-1)).toBeUndefined();
    app.receive({ type: 'artipod:runtime-lifecycle/v1/ready', state: 'running' });
    expect(app.states.at(-1)?.state).toBe('running');
    // a query after `unsupported` re-opens the question
    const late = harness();
    vi.advanceTimersByTime(5000);
    expect(late.states.at(-1)).toEqual({ state: 'unsupported' });
    late.controller.query();
    expect(late.states.at(-1)).toEqual({ state: 'unknown' });
    late.receive({ type: 'artipod:runtime-lifecycle/v1/ready', state: 'running' });
    expect(late.states.at(-1)?.state).toBe('running');
    app.controller.dispose();
    late.controller.dispose();
    vi.useRealTimers();
  });
  it('fails when the app refuses and when the frame disappears', () => {
    vi.useFakeTimers();
    const app = harness();
    app.receive({ type: 'artipod:runtime-lifecycle/v1/ready', state: 'suspended' });
    app.controller.resume();
    app.receive({ type: 'artipod:runtime-lifecycle/v1/ack', id: app.lastRequest().id, state: 'suspended' });
    expect(app.states.at(-1)).toMatchObject({ state: 'error', error: 'Application did not confirm resume' });
    const gone = harness();
    gone.receive({ type: 'artipod:runtime-lifecycle/v1/ready', state: 'running' });
    gone.detach();
    gone.controller.suspend();
    expect(gone.states.at(-1)).toMatchObject({ state: 'error', error: 'Application frame unavailable' });
    expect(vi.getTimerCount()).toBe(2);
    app.controller.dispose();
    gone.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
