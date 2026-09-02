/**
 * Distribution read surface (serve plan S3): ping, manifests by tag and
 * digest, blobs (+Range), tags/list + _catalog pagination, OCI error
 * envelope, and the `<name>:<tag>` ⇄ /v2 path mapping helpers.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256, type Digest } from '../oci/digest.js';
import type { StoredRef } from '../oci/store.js';
import type { PodStore } from '../manager/pod-store.js';
import { createDistributionHandler, distRef, parseDistRef, splitRepoPath } from './distribution-handler.js';

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

const MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const store = new MemoryPodStore();
const handler = createDistributionHandler({ store });
let layerDigest: Digest;
let manifestDigest: Digest;
let manifestBytes: Uint8Array;

beforeAll(async () => {
  const layer = new TextEncoder().encode('layer bytes for distribution');
  layerDigest = await store.putBlob(layer);
  const manifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: layerDigest, size: layer.length },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: layerDigest, size: layer.length }],
  };
  manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  manifestDigest = await store.putBlob(manifestBytes);
  await store.putRef(distRef('my-notes', 'latest'), manifestDigest, MANIFEST_TYPE);
  await store.putRef(distRef('team/nested/name', 'v1'), manifestDigest, MANIFEST_TYPE);
  await store.putRef(distRef('my-notes', 'older'), manifestDigest, MANIFEST_TYPE);
});

const call = (path: string, init?: RequestInit): Promise<Response> =>
  handler(new Request(`http://reg.test/v2/${path}`, init), path.split('?')[0].split('/').filter(Boolean));

describe('ref-name mapping', () => {
  it('distRef/parseDistRef round-trip, nested names', () => {
    for (const [name, tag] of [
      ['my-notes', 'latest'],
      ['team/nested/name', 'v1.2.3'],
      ['a/b', 'T_underscore-dash.dot'],
    ] as const) {
      expect(parseDistRef(distRef(name, tag))).toEqual({ name, tag });
    }
    expect(parseDistRef('no-tag')).toBeNull();
    expect(parseDistRef(':startscolon')).toBeNull();
    expect(parseDistRef('UPPER/case:tag')).toBeNull();
  });

  it('splitRepoPath handles nested names and rejects junk', () => {
    expect(splitRepoPath(['team', 'nested', 'name', 'manifests', 'v1'])).toEqual({
      name: 'team/nested/name',
      kind: 'manifests',
      arg: 'v1',
    });
    expect(splitRepoPath(['my-notes', 'blobs', 'sha256:abc'])).toEqual({
      name: 'my-notes',
      kind: 'blobs',
      arg: 'sha256:abc',
    });
    expect(splitRepoPath(['my-notes', 'tags', 'list'])).toEqual({ name: 'my-notes', kind: 'tags', arg: 'list' });
    expect(splitRepoPath(['manifests', 'x'])).toBeNull();
    expect(splitRepoPath(['UPPER', 'manifests', 'x'])).toBeNull();
  });
});

describe('distribution read surface', () => {
  it('GET /v2/ pings with the API version header', async () => {
    const res = await call('');
    expect(res.status).toBe(200);
    expect(res.headers.get('docker-distribution-api-version')).toBe('registry/2.0');
  });

  it('manifest by tag: Docker-Content-Digest + declared media type; HEAD has no body', async () => {
    const res = await call('my-notes/manifests/latest');
    expect(res.status).toBe(200);
    expect(res.headers.get('docker-content-digest')).toBe(manifestDigest);
    expect(res.headers.get('content-type')).toBe(MANIFEST_TYPE);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(manifestBytes);
    const head = await call('my-notes/manifests/latest', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('docker-content-digest')).toBe(manifestDigest);
    expect(await head.text()).toBe('');
  });

  it('manifest by digest and for nested names', async () => {
    const byDigest = await call(`my-notes/manifests/${manifestDigest}`);
    expect(byDigest.status).toBe(200);
    const nested = await call('team/nested/name/manifests/v1');
    expect(nested.status).toBe(200);
  });

  it('unknown manifest → 404 OCI error envelope', async () => {
    const res = await call('my-notes/manifests/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { errors: { code: string }[] };
    expect(body.errors[0].code).toBe('MANIFEST_UNKNOWN');
  });

  it('blobs: GET with digest header, Range 206, HEAD, 404 envelope', async () => {
    const full = await call(`my-notes/blobs/${layerDigest}`);
    expect(full.status).toBe(200);
    expect(full.headers.get('docker-content-digest')).toBe(layerDigest);
    const ranged = await call(`my-notes/blobs/${layerDigest}`, { headers: { range: 'bytes=6-' } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('bytes for distribution');
    const head = await call(`my-notes/blobs/${layerDigest}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    const missing = await call(`my-notes/blobs/sha256:${'0'.repeat(64)}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { errors: { code: string }[] }).errors[0].code).toBe('BLOB_UNKNOWN');
  });

  it('tags/list with pagination + Link header', async () => {
    const all = await call('my-notes/tags/list');
    expect(await all.json()).toEqual({ name: 'my-notes', tags: ['latest', 'older'] });
    const first = await call('my-notes/tags/list?n=1');
    const firstBody = (await first.json()) as { tags: string[] };
    expect(firstBody.tags).toEqual(['latest']);
    expect(first.headers.get('link')).toContain('last=latest');
    const second = await call('my-notes/tags/list?n=1&last=latest');
    expect(((await second.json()) as { tags: string[] }).tags).toEqual(['older']);
    expect(second.headers.get('link')).toBeNull();
    const unknown = await call('nope/tags/list');
    expect(unknown.status).toBe(404);
  });

  it('_catalog lists distinct names with pagination', async () => {
    const res = await call('_catalog');
    expect(await res.json()).toEqual({ repositories: ['my-notes', 'team/nested/name'] });
    const paged = await call('_catalog?n=1');
    expect(await paged.json()).toEqual({ repositories: ['my-notes'] });
    expect(paged.headers.get('link')).toContain('_catalog');
  });

  it('push endpoints answer 405 until S4', async () => {
    const res = await call('my-notes/manifests/latest', { method: 'PUT', body: '{}' });
    expect(res.status).toBe(405);
  });
});
