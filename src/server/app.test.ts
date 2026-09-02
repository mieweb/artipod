/**
 * createArtipodApp (serve plan S0): route dispatch to the existing handlers,
 * surface flags, 404 JSON for unknown routes, and the CORS wrapper
 * (deny-by-default, exact-origin, preflight, expose-headers).
 */
import { describe, expect, it } from 'vitest';
import { sha256, type Digest } from '../oci/digest.js';
import type { StoredRef } from '../oci/store.js';
import type { PodStore } from '../manager/pod-store.js';
import { createArtipodApp } from './app.js';
import { withCors } from './cors.js';
import { json, staticTokenAuth } from './common.js';

class MemoryPodStore implements PodStore {
  private blobs = new Map<string, Uint8Array>();
  private refs = new Map<string, StoredRef>();
  async hasBlob(digest: Digest): Promise<boolean> {
    return this.blobs.has(digest);
  }
  async getBlob(digest: Digest): Promise<Uint8Array> {
    const b = this.blobs.get(digest);
    if (!b) throw new Error('missing');
    return b;
  }
  async putBlob(bytes: Uint8Array, expected?: Digest): Promise<Digest> {
    const digest = await sha256(bytes);
    if (expected && expected !== digest) throw new Error('digest mismatch');
    this.blobs.set(digest, bytes);
    return digest;
  }
  async getRef(ref: string): Promise<StoredRef | null> {
    return this.refs.get(ref) ?? null;
  }
  async putRef(ref: string, manifestDigest: Digest, mediaType: string): Promise<void> {
    this.refs.set(ref, { ref, manifestDigest, mediaType } as StoredRef);
  }
  async listRefs(): Promise<StoredRef[]> {
    return [...this.refs.values()];
  }
}

const base = 'http://serve.test';

describe('createArtipodApp', () => {
  it('routes /api/pods to the pod-store handler (blob round trip + refs)', async () => {
    const app = createArtipodApp({ store: new MemoryPodStore() });
    const bytes = new TextEncoder().encode('app routing blob');
    const digest = await sha256(bytes);
    const put = await app(new Request(`${base}/api/pods/blobs/${digest}`, { method: 'PUT', body: bytes }));
    expect(put.status).toBe(201);
    const get = await app(new Request(`${base}/api/pods/blobs/${digest}`));
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
    const refs = await app(new Request(`${base}/api/pods/refs`));
    expect(await refs.json()).toEqual([]);
  });

  it('routes /api/oci to the relay (deny-all by default)', async () => {
    const app = createArtipodApp({ store: new MemoryPodStore() });
    const res = await app(new Request(`${base}/api/oci/registry-1.docker.io/v2/`));
    expect(res.status).toBe(403);
  });

  it('routes /api/git to the proxy (OPTIONS preflight gets git CORS)', async () => {
    const app = createArtipodApp({ store: new MemoryPodStore() });
    const res = await app(new Request(`${base}/api/git/github.com/x/y/info/refs`, { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('exec surface is off unless configured', async () => {
    const app = createArtipodApp({ store: new MemoryPodStore() });
    const res = await app(
      new Request(`${base}/api/exec`, { method: 'POST', body: JSON.stringify({ sessionId: 's', command: 'pwd' }) }),
    );
    expect(res.status).toBe(404);
  });

  it('unknown routes return 404 JSON', async () => {
    const app = createArtipodApp({ store: new MemoryPodStore() });
    for (const path of ['/', '/api/nope']) {
      const res = await app(new Request(`${base}${path}`));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('not found');
    }
  });

  it('routes /v2/ to the distribution handler (ping), off with --only web', async () => {
    const app = createArtipodApp({ store: new MemoryPodStore() });
    const ping = await app(new Request(`${base}/v2/`));
    expect(ping.status).toBe(200);
    expect(ping.headers.get('docker-distribution-api-version')).toBe('registry/2.0');
    const webOnly = createArtipodApp({ store: new MemoryPodStore(), surfaces: { registry: false } });
    expect((await webOnly(new Request(`${base}/v2/`))).status).toBe(404);
  });

  it('--only registry (web:false) turns the web surface off', async () => {
    const app = createArtipodApp({ store: new MemoryPodStore(), surfaces: { web: false } });
    const res = await app(new Request(`${base}/api/pods/refs`));
    expect(res.status).toBe(404);
  });

  it('locked refs refuse head moves on both surfaces and surface `locked` in the refs list', async () => {
    const store = new MemoryPodStore();
    const app = createArtipodApp({ store, isLocked: (ref) => ref === 'pins/app:1' });
    // seed a manifest the ref PUTs can point at
    const manifest = new TextEncoder().encode(JSON.stringify({ schemaVersion: 2, config: undefined, layers: [] }));
    const manifestDigest = await store.putBlob(manifest);
    await store.putRef('pins/app:1', manifestDigest, 'application/vnd.oci.image.manifest.v1+json');

    // native surface: PUT refs on the locked name → 403; an unlocked name lands
    const putRef = (ref: string) =>
      app(new Request(`${base}/api/pods/refs`, { method: 'PUT', body: JSON.stringify({ ref, manifestDigest }) }));
    expect((await putRef('pins/app:1')).status).toBe(403);
    expect((await putRef('free/app:1')).status).toBe(201);

    // /v2 surface: tag-moving manifest PUT → 403 DENIED; digest PUT (no tag move) is fine
    const v2Put = (arg: string) =>
      app(
        new Request(`${base}/v2/pins/app/manifests/${arg}`, {
          method: 'PUT',
          body: manifest,
          headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
        }),
      );
    const deniedV2 = await v2Put('1');
    expect(deniedV2.status).toBe(403);
    expect(((await deniedV2.json()) as { errors: { code: string }[] }).errors[0].code).toBe('DENIED');
    expect((await v2Put(manifestDigest)).status).toBe(201);

    // reads are untouched, and the list carries the lock
    const refs = (await (await app(new Request(`${base}/api/pods/refs`))).json()) as { ref: string; locked?: boolean }[];
    expect(refs.find((r) => r.ref === 'pins/app:1')?.locked).toBe(true);
    expect(refs.find((r) => r.ref === 'free/app:1')?.locked).toBeUndefined();
  });
});

describe('withCors', () => {
  const echo = withCors(async () => json({ ok: true }), ['http://allowed.example']);

  it('empty allowlist = passthrough (no CORS headers ever)', async () => {
    const bare = withCors(async () => json({ ok: true }), []);
    const res = await bare(new Request(`${base}/x`, { headers: { origin: 'http://allowed.example' } }), []);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allowed origin gets exact-match ACAO + expose headers', async () => {
    const res = await echo(new Request(`${base}/x`, { headers: { origin: 'http://allowed.example' } }), []);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://allowed.example');
    expect(res.headers.get('access-control-expose-headers')).toContain('Docker-Content-Digest');
    expect(res.headers.get('access-control-expose-headers')).toContain('Content-Range');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('a disallowed origin gets the response but no CORS headers', async () => {
    const res = await echo(new Request(`${base}/x`, { headers: { origin: 'http://evil.example' } }), []);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('preflight: 204 for allowed origins, 403 without CORS headers otherwise', async () => {
    const ok = await echo(
      new Request(`${base}/x`, { method: 'OPTIONS', headers: { origin: 'http://allowed.example' } }),
      [],
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-methods')).toContain('PUT');
    const bad = await echo(
      new Request(`${base}/x`, { method: 'OPTIONS', headers: { origin: 'http://evil.example' } }),
      [],
    );
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('applies to /api/pods inside the app when cors origins are configured', async () => {
    const app = createArtipodApp({ store: new MemoryPodStore(), cors: ['http://ui.example'] });
    const res = await app(new Request(`${base}/api/pods/refs`, { headers: { origin: 'http://ui.example' } }));
    expect(res.headers.get('access-control-allow-origin')).toBe('http://ui.example');
  });
});

describe('staticTokenAuth matrix (S5)', () => {
  const auth = staticTokenAuth({ rw: () => 'rw-secret', ro: () => 'ro-secret' });
  const app = createArtipodApp({
    store: new MemoryPodStore(),
    auth,
    fallback: async () => json({ landing: true }),
  });
  const basic = (t: string): string => `Basic ${btoa(`anyuser:${t}`)}`;
  const req = (path: string, init: RequestInit = {}, token?: string, scheme: 'bearer' | 'basic' = 'bearer') =>
    app(
      new Request(`${base}${path}`, {
        ...init,
        headers: token ? { authorization: scheme === 'bearer' ? `Bearer ${token}` : basic(token) } : {},
      }),
    );

  const digestOf = async (bytes: Uint8Array): Promise<string> => sha256(bytes);

  it('no token → 401 with the Basic challenge on every surface', async () => {
    for (const [path, init] of [
      ['/api/pods/refs', {}],
      ['/v2/', {}],
      ['/api/exec', { method: 'POST', body: '{}' }],
      ['/', {}],
    ] as [string, RequestInit][]) {
      const res = await req(path, init);
      expect(res.status, path).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Basic');
    }
  });

  it('ro token: reads pass (Bearer and Basic), writes 403', async () => {
    expect((await req('/api/pods/refs', {}, 'ro-secret')).status).toBe(200);
    expect((await req('/api/pods/refs', {}, 'ro-secret', 'basic')).status).toBe(200);
    expect((await req('/v2/', {}, 'ro-secret')).status).toBe(200);
    expect((await req('/', {}, 'ro-secret')).status).toBe(200);
    const bytes = new TextEncoder().encode('matrix blob');
    const digest = await digestOf(bytes);
    const write = await req(`/api/pods/blobs/${digest}`, { method: 'PUT', body: bytes as BodyInit }, 'ro-secret');
    expect(write.status).toBe(403);
    const push = await req('/v2/x/blobs/uploads/', { method: 'POST' }, 'ro-secret');
    expect(push.status).toBe(403);
  });

  it('rw token: reads and writes pass (Bearer and Basic — the docker login path)', async () => {
    const bytes = new TextEncoder().encode('matrix blob rw');
    const digest = await digestOf(bytes);
    expect(
      (await req(`/api/pods/blobs/${digest}`, { method: 'PUT', body: bytes as BodyInit }, 'rw-secret')).status,
    ).toBe(201);
    expect((await req('/v2/x/blobs/uploads/', { method: 'POST' }, 'rw-secret', 'basic')).status).toBe(202);
    expect((await req('/api/pods/refs', {}, 'rw-secret')).status).toBe(200);
  });

  it('a wrong token is 401 everywhere', async () => {
    expect((await req('/api/pods/refs', {}, 'nope')).status).toBe(401);
    expect((await req('/v2/', {}, 'nope', 'basic')).status).toBe(401);
  });
});
