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

  it('push endpoints are 403 when readonly', async () => {
    const ro = createDistributionHandler({ store, readonly: true });
    const res = await ro(
      new Request('http://reg.test/v2/my-notes/blobs/uploads/', { method: 'POST' }),
      ['my-notes', 'blobs', 'uploads'],
    );
    expect(res.status).toBe(403);
  });
});

describe('distribution write surface (S4)', () => {
  const put = async (bytes: Uint8Array, name = 'pushed/repo'): Promise<Digest> => {
    const open = await call(`${name}/blobs/uploads/`, { method: 'POST' });
    expect(open.status).toBe(202);
    const id = open.headers.get('docker-upload-uuid')!;
    const digest = await sha256(bytes);
    const done = await call(`${name}/blobs/uploads/${id}?digest=${digest}`, { method: 'PUT', body: bytes as BodyInit });
    expect(done.status).toBe(201);
    expect(done.headers.get('docker-content-digest')).toBe(digest);
    return digest;
  };

  it('chunked upload: POST → PATCH ×2 → PUT with digest verification', async () => {
    const open = await call('pushed/repo/blobs/uploads/', { method: 'POST' });
    expect(open.status).toBe(202);
    const id = open.headers.get('docker-upload-uuid')!;
    expect(open.headers.get('location')).toContain(id);

    const p1 = await call(`pushed/repo/blobs/uploads/${id}`, { method: 'PATCH', body: 'first-' });
    expect(p1.status).toBe(202);
    expect(p1.headers.get('range')).toBe('0-5');
    const p2 = await call(`pushed/repo/blobs/uploads/${id}`, { method: 'PATCH', body: 'second' });
    expect(p2.headers.get('range')).toBe('0-11');

    const whole = new TextEncoder().encode('first-second');
    const digest = await sha256(whole);
    const done = await call(`pushed/repo/blobs/uploads/${id}?digest=${digest}`, { method: 'PUT' });
    expect(done.status).toBe(201);
    expect(await store.getBlob(digest)).toEqual(whole);
    // session consumed
    const gone = await call(`pushed/repo/blobs/uploads/${id}`, { method: 'PATCH', body: 'x' });
    expect(gone.status).toBe(404);
  });

  it('a lying digest bounces the upload and stores nothing', async () => {
    const open = await call('pushed/repo/blobs/uploads/', { method: 'POST' });
    const id = open.headers.get('docker-upload-uuid')!;
    const bad = `sha256:${'0'.repeat(64)}`;
    const done = await call(`pushed/repo/blobs/uploads/${id}?digest=${bad}`, { method: 'PUT', body: 'tampered' });
    expect(done.status).toBe(400);
    expect(await store.hasBlob(bad as Digest)).toBe(false);
  });

  it('monolithic POST with ?digest= (crane happy path)', async () => {
    const bytes = new TextEncoder().encode('monolithic bytes');
    const digest = await sha256(bytes);
    const res = await call(`pushed/repo/blobs/uploads/?digest=${digest}`, { method: 'POST', body: bytes as BodyInit });
    expect(res.status).toBe(201);
    expect(await store.hasBlob(digest)).toBe(true);
  });

  it('cross-repo mount is a free 201 (same store)', async () => {
    const bytes = new TextEncoder().encode('mounted blob');
    const digest = await put(bytes, 'repo/a');
    const res = await call(`repo/b/blobs/uploads/?mount=${digest}&from=repo/a`, { method: 'POST' });
    expect(res.status).toBe(201);
    expect(res.headers.get('location')).toBe(`/v2/repo/b/blobs/${digest}`);
  });

  it('manifest PUT verifies referenced blobs, tags overwrite (V8), then pulls back', async () => {
    const layer = new TextEncoder().encode('pushed layer');
    const layerD = await put(layer);
    const manifest = (config: string): Uint8Array =>
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 2,
          mediaType: MANIFEST_TYPE,
          config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: config, size: 1 },
          layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: layerD, size: layer.length }],
        }),
      );

    // referencing a missing blob → 400 MANIFEST_BLOB_UNKNOWN
    const missing = await call('pushed/repo/manifests/v1', {
      method: 'PUT',
      body: manifest(`sha256:${'1'.repeat(64)}`) as BodyInit,
      headers: { 'content-type': MANIFEST_TYPE },
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { errors: { code: string }[] }).errors[0].code).toBe('MANIFEST_BLOB_UNKNOWN');

    const good = manifest(layerD);
    const putRes = await call('pushed/repo/manifests/v1', {
      method: 'PUT',
      body: good as BodyInit,
      headers: { 'content-type': MANIFEST_TYPE },
    });
    expect(putRes.status).toBe(201);
    const digest = putRes.headers.get('docker-content-digest')!;

    // visible via the native ref namespace and pullable back
    expect((await store.getRef(distRef('pushed/repo', 'v1')))?.manifestDigest).toBe(digest);
    const pulled = await call('pushed/repo/manifests/v1');
    expect(pulled.headers.get('docker-content-digest')).toBe(digest);

    // V8: a second PUT to the same tag overwrites, no merge
    const layer2 = new TextEncoder().encode('replacement layer');
    const layer2D = await put(layer2);
    const second = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: MANIFEST_TYPE,
        config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: layer2D, size: 1 },
        layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: layer2D, size: layer2.length }],
      }),
    );
    const overwrite = await call('pushed/repo/manifests/v1', {
      method: 'PUT',
      body: second as BodyInit,
      headers: { 'content-type': MANIFEST_TYPE },
    });
    expect(overwrite.status).toBe(201);
    expect((await store.getRef(distRef('pushed/repo', 'v1')))?.manifestDigest).toBe(
      overwrite.headers.get('docker-content-digest'),
    );
  });

  it('out-of-order chunks are 416 (Content-Range must continue the offset)', async () => {
    const open = await call('pushed/repo/blobs/uploads/', { method: 'POST' });
    const id = open.headers.get('docker-upload-uuid')!;
    const bad = await call(`pushed/repo/blobs/uploads/${id}`, {
      method: 'PATCH',
      body: 'chunk',
      headers: { 'content-range': '5-9' },
    });
    expect(bad.status).toBe(416);
    const good = await call(`pushed/repo/blobs/uploads/${id}`, {
      method: 'PATCH',
      body: 'chunk',
      headers: { 'content-range': '0-4' },
    });
    expect(good.status).toBe(202);
  });

  it('subject manifests get OCI-Subject and show up in /referrers', async () => {
    const layer = new TextEncoder().encode('referrer layer');
    const layerD = await put(layer);
    const subjectDigest = `sha256:${'a'.repeat(64)}`; // may not exist — legal
    const artifact = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: MANIFEST_TYPE,
        artifactType: 'application/vnd.example.sbom',
        subject: { mediaType: MANIFEST_TYPE, digest: subjectDigest, size: 1 },
        config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: layerD, size: 1 },
        layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: layerD, size: layer.length }],
      }),
    );
    const res = await call('pushed/repo/manifests/sbom', {
      method: 'PUT',
      body: artifact as BodyInit,
      headers: { 'content-type': MANIFEST_TYPE },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('oci-subject')).toBe(subjectDigest);
    const list = await call(`pushed/repo/referrers/${subjectDigest}`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { manifests: { digest: string; artifactType?: string }[] };
    expect(body.manifests).toHaveLength(1);
    expect(body.manifests[0].artifactType).toBe('application/vnd.example.sbom');
    // filtered
    const none = await call(`pushed/repo/referrers/${subjectDigest}?artifactType=application/other`);
    expect(((await none.json()) as { manifests: unknown[] }).manifests).toHaveLength(0);
  });

  it('non-distributable layers skip the existence check', async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: MANIFEST_TYPE,
        config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: layerDigest, size: 1 },
        layers: [
          {
            mediaType: 'application/vnd.oci.image.layer.nondistributable.v1.tar+gzip',
            digest: `sha256:${'b'.repeat(64)}`,
            size: 5,
          },
        ],
      }),
    );
    const res = await call('pushed/repo/manifests/foreign', {
      method: 'PUT',
      body: bytes as BodyInit,
      headers: { 'content-type': MANIFEST_TYPE },
    });
    expect(res.status).toBe(201);
  });

  it('manifest PUT by digest requires an exact match', async () => {
    const layer = new TextEncoder().encode('digest-put layer');
    const layerD = await put(layer);
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: MANIFEST_TYPE,
        config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: layerD, size: 1 },
        layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: layerD, size: layer.length }],
      }),
    );
    const digest = await sha256(bytes);
    const ok = await call(`pushed/repo/manifests/${digest}`, { method: 'PUT', body: bytes as BodyInit });
    expect(ok.status).toBe(201);
    const bad = await call(`pushed/repo/manifests/sha256:${'2'.repeat(64)}`, { method: 'PUT', body: bytes as BodyInit });
    expect(bad.status).toBe(400);
  });
});
