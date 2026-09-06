import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function harness() {
  const handlers = new Map<string, (event: Record<string, unknown>) => void>();
  const listeners = new Set<(event: { data: unknown }) => void>();
  const origin = 'https://artipod.example';
  const session = '11111111-1111-4111-8111-111111111111';
  const owner = { id: 'owner', url: `${origin}/?artipod=local-app` };
  const port = {
    start() {}, close() {},
    addEventListener(_name: string, callback: (event: { data: unknown }) => void) { listeners.add(callback); },
    removeEventListener(_name: string, callback: (event: { data: unknown }) => void) { listeners.delete(callback); },
    postMessage(data: { type: string; id: string }) {
      if (data.type === 'read') queueMicrotask(() => { for (const callback of listeners) callback({ data: { id: data.id, status: 200, bytes: new Uint8Array([65]), mime: 'text/html' } }); });
    },
  };
  runInNewContext(readFileSync(new URL('./runtime-sw.js', import.meta.url), 'utf8'), {
    URL, Response, Uint8Array, crypto, setTimeout, clearTimeout,
    self: { location: { origin }, clients: { get: async () => owner }, addEventListener: (name: string, handler: (event: Record<string, unknown>) => void) => handlers.set(name, handler) },
  });
  return {
    owner,
    grant(source = owner, validUntil = Date.now() + 60000) { handlers.get('message')!({ source, data: { type: 'grant', session, entrypoint: '/app/index.html', validUntil }, ports: [port] }); },
    revoke() { handlers.get('message')!({ source: owner, data: { type: 'revoke', session } }); },
    async fetch(path = '/app/index.html', destination = 'iframe', clientId = '', method = 'GET') {
      let response: Promise<Response> | undefined;
      handlers.get('fetch')!({ request: { url: `${origin}/_artipod/run/${session}${path}`, method, destination, mode: destination === 'iframe' || destination === 'document' ? 'navigate' : 'cors' },
        clientId, resultingClientId: 'guest', respondWith: (value: Promise<Response>) => { response = value; } });
      return response!;
    },
  };
}

describe('main-origin runtime worker', () => {
  it('denies unadmitted URLs and catalog/guest grants', async () => {
    const worker = harness();
    expect((await worker.fetch()).status).toBe(403);
    worker.grant({ id: 'owner', url: 'https://artipod.example/' });
    expect((await worker.fetch()).status).toBe(403);
    worker.grant({ id: 'guest', url: 'https://artipod.example/_artipod/run/guest/app/index.html' });
    expect((await worker.fetch()).status).toBe(403);
  });
  it('admits an iframe then its assets, but never top-level or worker entrypoints', async () => {
    const worker = harness(); worker.grant();
    expect((await worker.fetch()).status).toBe(200);
    expect((await worker.fetch('/app/main.js', 'script', 'guest')).status).toBe(200);
    for (const destination of ['document', 'worker', 'serviceworker', 'sharedworker']) {
      expect((await worker.fetch('/app/index.html', destination, 'owner')).status).toBe(403);
    }
    expect((await worker.fetch('/app/main.js', 'script', 'stranger')).status).toBe(403);
  });
  it('denies expiry, writes, path escapes, revoked and navigated owners', async () => {
    const worker = harness(); worker.grant(undefined, Date.now() - 1);
    expect((await worker.fetch()).status).toBe(403);
    worker.grant();
    expect((await worker.fetch('/app/%2fsecret')).status).toBe(403);
    expect((await worker.fetch('/app/index.html', 'iframe', '', 'PUT')).status).toBe(403);
    worker.revoke(); expect((await worker.fetch()).status).toBe(403);
    worker.grant(); worker.owner.url = 'https://artipod.example/?artipod=different';
    expect((await worker.fetch()).status).toBe(403);
  });
});