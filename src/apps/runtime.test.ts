import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserRuntime, boundedResponse, type BrowserRuntime } from './runtime.js';
import type { ApplicationFiles } from './files.js';
import { exportJWK, FlattenedSign, generateKeyPair } from 'jose';
import { captureApplication } from './capture.js';
import { evidenceDigest, MAX_FRESHNESS_MS, STATEMENT_TYPES } from './admission.js';
import { ProcessTable } from '../proc/processes.js';

class Port {
  onmessage?: (event: { data: unknown }) => void;
  peer?: Port;
  closed = false;
  close() { this.closed = true; }
  postMessage(data: unknown) {
    queueMicrotask(() => { if (!this.peer?.closed) this.peer?.onmessage?.({ data }); });
  }
}

describe('selected pod runtime', () => {
  let runtime: BrowserRuntime;
  let content: Map<string, string>;
  let files: ApplicationFiles;
  let grants: Port[];
  let acknowledge: boolean;
  const descriptor = (capabilities: string[] = []) => JSON.stringify({
    apiVersion: 'artipod.io/v1', kind: 'SPAPod', metadata: { name: 'Selected application' },
    spec: { entrypoint: 'index.html', capabilities },
  });
  beforeEach(() => {
    vi.useFakeTimers();
    content = new Map([['artipod.json', descriptor()], ['index.html', '<h1>Selected pod</h1>']]);
    files = {
      list: async () => [...content.keys()],
      stat: async path => ({ size: content.get(path.slice(10))?.length ?? 0, isDirectory: () => path === '/selected', isSymbolicLink: () => false }),
      read: async path => new TextEncoder().encode(content.get(path.slice(10))),
    };
    grants = [];
    acknowledge = true;
    vi.stubGlobal('MessageChannel', class {
      port1 = new Port(); port2 = new Port();
      constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; }
    });
    vi.stubGlobal('navigator', { serviceWorker: {
      controller: {}, ready: Promise.resolve(),
      register: async () => ({ active: { postMessage(message: { type: string }, ports?: Port[]) {
        if (message.type === 'grant' && ports) {
          grants.push(ports[0]);
          if (acknowledge) ports[0].postMessage({ type: 'ready' });
        }
      } } }),
    } });
    runtime = createBrowserRuntime(files, '/selected');
  });
  afterEach(() => { runtime.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('requires explicit authorization, reuses it only for unchanged requirements, and clears it on stop', async () => {
    await runtime.launch('development');
    expect(runtime.store.getState().error).toContain('authorization required');
    expect(grants).toHaveLength(0);
    await runtime.launch('development', true);
    expect(runtime.store.getState().phase).toBe('running');
    content.set('index.html', '<h1>Saved edit</h1>');
    await runtime.launch('development');
    expect(runtime.store.getState().phase).toBe('running');
    content.set('artipod.json', descriptor(['network']));
    await runtime.launch('development');
    expect(runtime.store.getState().error).toContain('authorization required');
    await runtime.launch('development', true);
    runtime.stop();
    await runtime.launch('development');
    expect(runtime.store.getState().error).toContain('authorization required');
  });

  it('serves immutable saved bytes from the selected pod until reload', async () => {
    await runtime.launch('development', true);
    content.set('index.html', 'Changed after capture');
    const response = new Promise<{ bytes: Uint8Array }>(resolve => {
      grants[0].onmessage = event => resolve(event.data as { bytes: Uint8Array });
    });
    grants[0].postMessage({ type: 'read', id: 'read1', path: '/app/index.html' });
    expect(new TextDecoder().decode((await response).bytes)).toBe('<h1>Selected pod</h1>');
    expect(runtime.store.getState().url).toMatch(/^\/_artipod\/run\/.+\/app\/index.html$/);
  });

  it('registers each instance as an app process and routes signals through the attached controller', async () => {
    const table = new ProcessTable('session');
    runtime.dispose();
    runtime = createBrowserRuntime(files, '/selected', { processes: table, detail: { pod: 'demo:_1' } });
    const controller = { suspend: vi.fn(), resume: vi.fn() };
    await expect(table.signal(2, 'STOP')).rejects.toMatchObject({ code: 'ESRCH' });
    await runtime.launch('development', true);
    const { pid } = runtime.store.getState();
    expect(pid).toBe(2);
    expect(table.get(2)).toMatchObject({ kind: 'app', name: 'Selected application', state: 'running', detail: { pod: 'demo:_1', mode: 'development' }, signals: ['STOP', 'CONT', 'TERM', 'KILL'] });
    await expect(table.signal(2, 'STOP')).rejects.toThrow('does not support suspend');
    const detach = runtime.attach(controller);
    await table.signal(2, 'STOP');
    expect(controller.suspend).toHaveBeenCalledTimes(1);
    runtime.report({ state: 'suspended', telemetry: { elapsedMs: 4200, retainedBytes: 65536, limitBytes: 8388608 } });
    expect(table.get(2)).toMatchObject({ state: 'suspended', detail: { elapsed: '4s', retained: '64KiB' } });
    expect(runtime.store.getState().lifecycle?.state).toBe('suspended');
    await table.signal(2, 'CONT');
    expect(controller.resume).toHaveBeenCalledTimes(1);
    detach();
    await expect(table.signal(2, 'STOP')).rejects.toThrow('does not support suspend');
    await table.signal(2, 'TERM');
    expect(runtime.store.getState()).toEqual({ phase: 'stopped' });
    expect(table.get(2)).toBeUndefined();
    await runtime.launch('development');
    expect(runtime.store.getState().error).toContain('authorization required');
  });

  it('fails closed on missing host evidence without development fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    await runtime.launch('release');
    expect(runtime.store.getState().error).toBe('Approved execution is not configured on this server.');
    expect(grants).toHaveLength(0);
  });

  it('distinguishes missing application approval from missing server configuration', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/execution-policy.json'
      ? Response.json({}) : new Response(null, { status: 404 })));
    await runtime.launch('release');
    expect(runtime.store.getState().error).toBe('No signed approval is available for this version of the application.');
    expect(grants).toHaveLength(0);
  });

  it.each([401, 403, 500])('does not misreport HTTP %s as missing approval configuration', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
    await runtime.launch('release');
    expect(runtime.store.getState().error).toBe(status === 500
      ? 'The server could not provide approval information. Try again later.'
      : 'You do not have access to the approval information. Contact the server administrator.');
    expect(grants).toHaveLength(0);
  });

  it('explains connection failures without exposing a raw fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await runtime.launch('release');
    expect(runtime.store.getState().error).toBe('Cannot reach the approval server. Check your connection and try again.');
    expect(grants).toHaveLength(0);
  });

  it('does not let a cancelled grant timeout replace a newer running session', async () => {
    acknowledge = false;
    const cancelled = runtime.launch('development', true);
    await vi.waitFor(() => expect(grants).toHaveLength(1));
    acknowledge = true;
    await runtime.launch('development', true);
    await vi.advanceTimersByTimeAsync(8000);
    await cancelled;
    expect(runtime.store.getState().phase).toBe('running');
  });

  it('revokes on expiry and refuses launch after disposal', async () => {
    await runtime.launch('development', true);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runtime.store.getState().phase).toBe('stopped');
    runtime.dispose();
    await expect(runtime.launch('development', true)).rejects.toThrow('Workspace closed');
  });

  it('bounds host response bodies', async () => {
    await expect(boundedResponse(new Response('oversized'), 2)).rejects.toThrow('too large');
  });

  it('verifies independent host-pinned signatures against the selected saved composition', async () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const captured = await captureApplication({ paths: [...content.keys()].map(path => `/app/${path}`),
      read: async path => new TextEncoder().encode(content.get(path.slice(5))),
    });
    const publisher = await generateKeyPair('ES256');
    const reviewer = await generateKeyPair('ES256');
    const now = Date.now();
    const sign = async (type: string, id: string, privateKey: CryptoKey, claims: object) => JSON.stringify(
      await new FlattenedSign(encode({ schema: 'artipod.apps/v1', issuedAt: now, expiresAt: now + MAX_FRESHNESS_MS, ...claims }))
        .setProtectedHeader({ alg: 'ES256', typ: type, cty: 'application/json', kid: id }).sign(privateKey),
    );
    const attribution = await sign(STATEMENT_TYPES.publisher, 'publisher', publisher.privateKey, { subject: captured.subject });
    const approval = await sign(STATEMENT_TYPES.approval, 'reviewer', reviewer.privateKey, {
      id: 'selected-app', subject: captured.subject, publisherEvidenceDigest: await evidenceDigest(attribution), audience: 'local', mode: 'trusted-browser',
    });
    const status = await sign(STATEMENT_TYPES.status, 'reviewer', reviewer.privateKey, {
      approvalId: 'selected-app', approvalEvidenceDigest: await evidenceDigest(approval), revoked: false,
    });
    const policy = { publishers: [{ id: 'publisher', publicKey: await exportJWK(publisher.publicKey) }],
      approvers: [{ id: 'reviewer', publicKey: await exportJWK(reviewer.publicKey) }],
      audience: 'local', mode: 'trusted-browser', freshnessMs: MAX_FRESHNESS_MS,
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/execution-policy.json'
      ? policy : { publisher: attribution, approval, status })));
    await runtime.launch('release');
    expect(runtime.store.getState()).toMatchObject({ phase: 'running', mode: 'release', publisher: 'publisher', approver: 'reviewer', validUntil: now + MAX_FRESHNESS_MS });
    content.set('index.html', '<h1>Unapproved saved edit</h1>');
    await runtime.launch('release');
    expect(runtime.store.getState().error).toContain('subject mismatch');
    expect(runtime.store.getState().url).toBeUndefined();
    expect(grants).toHaveLength(1);
  });
});