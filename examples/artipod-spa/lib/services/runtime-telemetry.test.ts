import { describe, expect, it } from 'vitest';
import { observeRuntimeTelemetry, type RuntimeTelemetry } from './runtime-telemetry';

function fixture() {
  let listener: ((event: MessageEvent) => void) | undefined;
  const target = {
    addEventListener: (_type: string, value: (event: MessageEvent) => void) => { listener = value; },
    removeEventListener: (_type: string, value: (event: MessageEvent) => void) => { if (listener === value) listener = undefined; },
  } as Pick<Window, 'addEventListener' | 'removeEventListener'>;
  const owner = {} as Window;
  let current: Window | null = owner;
  let clock = 0;
  const reports: RuntimeTelemetry[] = [];
  const close = observeRuntimeTelemetry(target, 'https://host.test', () => current, value => reports.push(value), () => clock);
  const data = { type: 'artipod:runtime-telemetry/v1', elapsedMs: 1000, retainedBytes: 16384, limitBytes: 8388608 };
  return { reports, data, owner, close, tick: () => { clock += 1000; }, replace: () => { current = {} as Window; },
    send: (payload: unknown = data, origin = 'https://host.test', source: Window | null = owner) => listener?.({ data: payload, origin, source } as MessageEvent),
  };
}

describe('app-reported runtime telemetry', () => {
  it('accepts only the current iframe on the host origin', () => {
    const app = fixture();
    app.send(app.data, 'https://elsewhere.test');
    app.send(app.data, 'https://host.test', {} as Window);
    app.send(app.data, 'https://host.test', null);
    expect(app.reports).toHaveLength(0);
    app.send();
    expect(app.reports).toEqual([{ elapsedMs: 1000, retainedBytes: 16384, limitBytes: 8388608 }]);
    app.tick();
    app.replace();
    app.send();
    expect(app.reports).toHaveLength(1);
  });
  it.each([
    null, { type: undefined }, { type: 'unknown' }, { elapsedMs: NaN }, { elapsedMs: Infinity },
    { elapsedMs: -1 }, { retainedBytes: '16' }, { retainedBytes: -1 },
    { retainedBytes: 0.5 }, { retainedBytes: 8388609 }, { limitBytes: 0 }, { limitBytes: 2 ** 40 },
  ])('rejects invalid reports %j', invalid => {
    const app = fixture();
    app.send(invalid === null ? null : { ...app.data, ...invalid });
    expect(app.reports).toHaveLength(0);
  });
  it('throttles updates, detaches on stop, and starts a new observer empty', () => {
    const app = fixture();
    app.send();
    app.send();
    expect(app.reports).toHaveLength(1);
    app.tick();
    app.send();
    expect(app.reports).toHaveLength(2);
    app.close();
    app.tick();
    app.send();
    expect(app.reports).toHaveLength(2);
    const next = fixture();
    expect(next.reports).toHaveLength(0);
    next.send();
    expect(next.reports).toHaveLength(1);
    next.close();
  });
});