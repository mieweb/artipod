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
import { json } from './common.js';

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
    for (const path of ['/', '/api/nope', '/v2/']) {
      const res = await app(new Request(`${base}${path}`));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe('not found');
    }
  });

  it('--only registry (web:false) turns the web surface off', async () => {
    const app = createArtipodApp({ store: new MemoryPodStore(), surfaces: { web: false } });
    const res = await app(new Request(`${base}/api/pods/refs`));
    expect(res.status).toBe(404);
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
