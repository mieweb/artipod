import { readFileSync } from 'node:fs';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applicationSource } from '../files.js';
import { captureApplication } from '../capture.js';

const sampleRoot = new URL('../../../examples/lifecycle-app/', import.meta.url);
const source = readFileSync(new URL('main.js', sampleRoot), 'utf8');
function mount() {
  const nodes = new Map<string, { textContent: string; value: number; disabled?: boolean; onclick?: (() => void) | null }>();
  const reports: { elapsedMs: number; retainedBytes: number; limitBytes: number }[] = [];
  const messages: Record<string, unknown>[] = [];
  const buffers: Uint8Array[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let clock = 0;
  const parent = { postMessage: (data: Record<string, unknown>, origin: string) => {
    expect(origin).toBe('http://sample.test');
    if (data.type === 'artipod:runtime-telemetry/v1') reports.push(data as typeof reports[number]);
    else messages.push(data);
  } };
  runInNewContext(source, {
    document: { querySelector: (selector: string) => {
      if (!nodes.has(selector)) nodes.set(selector, { textContent: '', value: 0 });
      return nodes.get(selector);
    } },
    performance: { now: () => clock },
    location: { origin: 'http://sample.test' },
    parent,
    Uint8Array: class extends Uint8Array { constructor(length: number) { super(length); buffers.push(this); } },
    setInterval, clearInterval,
    addEventListener: (type: string, callback: (event: unknown) => void) => { listeners.set(type, callback); },
    removeEventListener: (type: string) => { listeners.delete(type); },
  });
  const send = (data: Record<string, unknown>, from: unknown = parent, origin = 'http://sample.test') =>
    listeners.get('message')?.({ source: from, origin, data });
  return { reports, messages, buffers, nodes, send, cleanup: () => listeners.get('pagehide')?.({}), setClock: (value: number) => { clock = value; } };
}
afterEach(() => vi.useRealTimers());
describe('lifecycle sample', () => {
  it('captures the complete durable sample with its entrypoint and binary assets', async () => {
    const root = fileURLToPath(sampleRoot);
    const files = await applicationSource({ read: async path => new Uint8Array(await readFile(path)), list: readdir, stat: lstat }, root);
    const captured = await captureApplication(files);
    expect(captured.entrypoint).toBe('index.html');
    expect(captured.read('/app/pixel.png').slice(0, 4)).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(captured.read('/app/probe.wasm')).toHaveLength(8);
    expect(new TextDecoder().decode(captured.read('/app/main.js'))).toContain('setInterval');
  });
  it('starts empty, retains touched buffers slowly, and reports elapsed clock time', () => {
    vi.useFakeTimers();
    const app = mount();
    expect(app.reports[0]).toMatchObject({ elapsedMs: 0, retainedBytes: 0 });
    app.setClock(3200);
    vi.advanceTimersByTime(1000);
    expect(app.reports.at(-1)).toMatchObject({ elapsedMs: 3200, retainedBytes: 16384 });
    expect(app.buffers[0].every(byte => byte === 1)).toBe(true);
    expect(app.nodes.get('#memory')?.textContent).toBe('16 KiB');
    app.cleanup();
    const count = app.reports.length;
    vi.advanceTimersByTime(5000);
    expect(app.reports).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('caps allocation at 8 MiB while continuing the clock and starts a new instance empty', () => {
    vi.useFakeTimers();
    const app = mount();
    app.setClock(600000);
    vi.advanceTimersByTime(600000);
    expect(app.buffers).toHaveLength(512);
    expect(app.reports.at(-1)).toMatchObject({ retainedBytes: 8388608, elapsedMs: 600000 });
    expect(app.nodes.get('#allocation-state')?.textContent).toBe('Allocation limit reached');
    app.nodes.get('#increment')?.onclick?.();
    expect(app.nodes.get('#count')?.textContent).toBe('1');
    app.cleanup();
    const next = mount();
    expect(next.reports[0].retainedBytes).toBe(0);
    next.cleanup();
  });
  it('suspends in place, keeps retained state, and resumes without counting paused time', () => {
    vi.useFakeTimers();
    const app = mount();
    expect(app.messages[0]).toMatchObject({ type: 'artipod:runtime-lifecycle/v1/ready', state: 'running' });
    app.setClock(3000);
    vi.advanceTimersByTime(3000);
    expect(app.buffers).toHaveLength(3);
    app.send({ type: 'artipod:runtime-lifecycle/v1/request', id: 'r1', command: 'suspend' });
    expect(app.messages.at(-1)).toMatchObject({ type: 'artipod:runtime-lifecycle/v1/ack', id: 'r1', state: 'suspended', telemetry: { elapsedMs: 3000, retainedBytes: 49152 } });
    expect(app.nodes.get('#increment')?.disabled).toBe(true);
    expect(app.nodes.get('#allocation-state')?.textContent).toBe('Suspended');
    const reports = app.reports.length;
    app.setClock(60000);
    vi.advanceTimersByTime(57000);
    expect(app.buffers).toHaveLength(3);
    expect(app.reports).toHaveLength(reports);
    expect(vi.getTimerCount()).toBe(0);
    app.send({ type: 'artipod:runtime-lifecycle/v1/request', id: 'r1', command: 'suspend' });
    app.send({ type: 'artipod:runtime-lifecycle/v1/query' });
    expect(app.messages.at(-1)).toMatchObject({ type: 'artipod:runtime-lifecycle/v1/ready', state: 'suspended', telemetry: { elapsedMs: 3000 } });
    app.send({ type: 'artipod:runtime-lifecycle/v1/request', id: 'r2', command: 'resume' }, {});
    app.send({ type: 'artipod:runtime-lifecycle/v1/request', id: 'r2', command: 'resume' }, undefined, 'http://evil.test');
    expect(app.buffers).toHaveLength(3);
    app.send({ type: 'artipod:runtime-lifecycle/v1/request', id: 'r2', command: 'resume' });
    app.send({ type: 'artipod:runtime-lifecycle/v1/request', id: 'r3', command: 'resume' });
    expect(app.messages.at(-1)).toMatchObject({ id: 'r3', state: 'running', telemetry: { elapsedMs: 3000, retainedBytes: 49152 } });
    expect(app.nodes.get('#increment')?.disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    app.setClock(62000);
    vi.advanceTimersByTime(2000);
    expect(app.buffers).toHaveLength(5);
    expect(app.reports.at(-1)).toMatchObject({ elapsedMs: 5000, retainedBytes: 81920 });
    app.cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});