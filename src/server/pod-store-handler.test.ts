/**
 * createPodStoreHandler: the HttpPodStore wire contract — blobs (incl.
 * Range 206 resume), refs, manifest-first 409, digest verification, auth
 * hook, and the onRefPut seam (Phase E's materialize hook).
 */
import { describe, expect, it } from 'vitest';
import { sha256, digestHex, type Digest } from '../oci/digest.js';
import type { StoredRef } from '../oci/store.js';
import type { PodStore } from '../manager/pod-store.js';
import { createPodStoreHandler } from './pod-store-handler.js';
import { bearerAuth } from './common.js';

/** Digest-verifying in-memory PodStore (mirrors real stores' tamper gate). */
class MemoryPodStore implements PodStore {
  private blobs = new Map<string, Uint8Array>();
  private refs = new Map<string, StoredRef>();

  async hasBlob(digest: Digest): Promise<boolean> {
    return this.blobs.has(digest);
  }
  async getBlob(digest: Digest): Promise<Uint8Array> {
    const bytes = this.blobs.get(digest);
    if (!bytes) throw new Error(`missing blob ${digest}`);
    return bytes;
  }
  async putBlob(bytes: Uint8Array, expected?: Digest): Promise<Digest> {
    const digest = await sha256(bytes);
    if (expected && expected !== digest) throw new Error(`digest mismatch: expected ${expected}, got ${digest}`);
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

const bytes = new TextEncoder().encode('hello artipod sync layer');
const base = 'http://manager.test/api/pods';
const req = (path: string, init?: RequestInit & { range?: string }) => {
  const headers = new Headers(init?.headers);
  if (init?.range) headers.set('range', init.range);
  return new Request(`${base}/${path}`, { ...init, headers });
};
const segs = (path: string) => path.split('?')[0].split('/');

describe('createPodStoreHandler', () => {
  it('round-trips blobs: PUT 201, HEAD 200, GET bytes, 404s for strangers', async () => {
    const handler = createPodStoreHandler({ store: new MemoryPodStore() });
    const digest = await sha256(bytes);

    expect((await handler(req(`blobs/${digest}`, { method: 'HEAD' }), segs(`blobs/${digest}`))).status).toBe(404);
    const put = await handler(req(`blobs/${digest}`, { method: 'PUT', body: bytes }), segs(`blobs/${digest}`));
    expect(put.status).toBe(201);
    expect((await handler(req(`blobs/${digest}`, { method: 'HEAD' }), segs(`blobs/${digest}`))).status).toBe(200);

    const get = await handler(req(`blobs/${digest}`), segs(`blobs/${digest}`));
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);

    const missing = `sha256:${'0'.repeat(64)}`;
    expect((await handler(req(`blobs/${missing}`), segs(`blobs/${missing}`))).status).toBe(404);
  });

  it('bounces tampered uploads with 400', async () => {
    const handler = createPodStoreHandler({ store: new MemoryPodStore() });
    const wrong = `sha256:${'a'.repeat(64)}`;
    const put = await handler(req(`blobs/${wrong}`, { method: 'PUT', body: bytes }), segs(`blobs/${wrong}`));
    expect(put.status).toBe(400);
    expect(((await put.json()) as { error: string }).error).toMatch(/mismatch/);
  });

  it('serves Range: bytes=N- as 206 with Content-Range; N past the end is 416', async () => {
    const store = new MemoryPodStore();
    const handler = createPodStoreHandler({ store });
    const digest = await store.putBlob(bytes);

    const partial = await handler(req(`blobs/${digest}`, { range: 'bytes=6-' }), segs(`blobs/${digest}`));
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 6-${bytes.length - 1}/${bytes.length}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(bytes.subarray(6));

    const whole = await handler(req(`blobs/${digest}`, { range: 'bytes=0-' }), segs(`blobs/${digest}`));
    expect(whole.status).toBe(206);
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);

    const past = await handler(req(`blobs/${digest}`, { range: `bytes=${bytes.length}-` }), segs(`blobs/${digest}`));
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${bytes.length}`);

    // shapes we don't implement fall back to 200-full (client handles both)
    const odd = await handler(req(`blobs/${digest}`, { range: 'bytes=0-5' }), segs(`blobs/${digest}`));
    expect(odd.status).toBe(200);
  });

  it('refs: manifest-first 409, then 201; get by name, list, 404', async () => {
    const store = new MemoryPodStore();
    const seen: string[] = [];
    const handler = createPodStoreHandler({
      store,
      onRefPut: (ref, digest) => void seen.push(`${ref}@${digestHex(digest).slice(0, 6)}`),
    });
    const manifestDigest = await sha256(bytes);
    const putRef = (body: unknown) =>
      handler(req('refs', { method: 'PUT', body: JSON.stringify(body) }), ['refs']);

    expect((await putRef({ ref: 'pod/demo', manifestDigest })).status).toBe(409);
    await store.putBlob(bytes);
    expect((await putRef({ ref: 'pod/demo', manifestDigest })).status).toBe(201);
    expect(seen).toHaveLength(1);

    const byName = await handler(req('refs?name=pod%2Fdemo'), ['refs']);
    expect(((await byName.json()) as StoredRef).manifestDigest).toBe(manifestDigest);
    const list = (await (await handler(req('refs'), ['refs'])).json()) as StoredRef[];
    expect(list).toHaveLength(1);
    expect((await handler(req('refs?name=nope'), ['refs'])).status).toBe(404);

    expect((await putRef({ ref: 'pod/demo' })).status).toBe(400);
    expect((await handler(req('refs', { method: 'PUT', body: '{oops' }), ['refs'])).status).toBe(400);
  });

  it('auth hook gates every method; usage 400 for unknown paths', async () => {
    const store = new MemoryPodStore();
    const digest = await store.putBlob(bytes);
    const handler = createPodStoreHandler({
      store,
      auth: bearerAuth(() => 'sekrit'),
    });

    expect((await handler(req(`blobs/${digest}`), segs(`blobs/${digest}`))).status).toBe(401);
    expect((await handler(req('refs', { method: 'PUT', body: '{}' }), ['refs'])).status).toBe(401);
    const ok = await handler(
      req(`blobs/${digest}`, { headers: { authorization: 'Bearer sekrit' } }),
      segs(`blobs/${digest}`),
    );
    expect(ok.status).toBe(200);

    const open = createPodStoreHandler({ store });
    expect((await open(req('wat'), ['wat'])).status).toBe(400);
    expect((await open(req('blobs/not-a-digest'), ['blobs', 'not-a-digest'])).status).toBe(400);
  });
});
