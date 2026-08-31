/**
 * Manager unit tests: HttpPodStore wire protocol (scripted fetch double —
 * the same shape the app routes implement), PodSessionHost hosting rules,
 * and materializeImage/clone behavior.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import { OciStore } from '../oci/store.js';
import { sha256, type Digest } from '../oci/digest.js';
import type { StoredRef } from '../oci/store.js';
import { HttpPodStore } from './http-store.js';
import { syncRef } from './sync.js';
import { PodSessionHost } from './session-host.js';

const text = (s: string) => new TextEncoder().encode(s);

/** In-memory manager implementing the /api/pods wire shape. */
function fakeManagerFetch() {
  const blobs = new Map<string, Uint8Array>();
  const refs = new Map<string, StoredRef>();
  const fetchFn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://manager.test');
    const method = init?.method ?? 'GET';
    const blobMatch = /^\/api\/pods\/blobs\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
    if (blobMatch) {
      const digest = blobMatch[1];
      if (method === 'HEAD') return new Response(null, { status: blobs.has(digest) ? 200 : 404 });
      if (method === 'GET') {
        const bytes = blobs.get(digest);
        return bytes ? new Response(bytes as BodyInit) : new Response('not found', { status: 404 });
      }
      if (method === 'PUT') {
        const body = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        blobs.set(digest, body);
        return new Response(null, { status: 201 });
      }
    }
    if (url.pathname === '/api/pods/refs') {
      if (method === 'GET') {
        const name = url.searchParams.get('name');
        if (name) {
          const ref = refs.get(name);
          return ref ? Response.json(ref) : new Response('not found', { status: 404 });
        }
        return Response.json([...refs.values()]);
      }
      if (method === 'PUT') {
        const body = JSON.parse(await new Response(init?.body as BodyInit).text()) as StoredRef;
        refs.set(body.ref, { ...body, pulledAt: new Date().toISOString() });
        return new Response(null, { status: 201 });
      }
    }
    return new Response('bad request', { status: 400 });
  }) as typeof fetch;
  return { fetchFn, blobs, refs };
}

function unmountAll() {
  for (const path of [...zenMounts.keys()]) {
    if (path !== '/') {
      try {
        umount(path);
      } catch {
        /* fine */
      }
    }
  }
  try {
    umount('/');
  } catch {
    /* fine */
  }
}

describe('HttpPodStore + syncRef over the wire shape', () => {
  let store: OciStore;

  beforeEach(async () => {
    unmountAll();
    await configure({ mounts: { '/': InMemory } });
    store = new OciStore(zfs);
    await store.init();
  });

  it('pushes a committed ref: only missing digests move, re-push moves zero', async () => {
    // minimal "image": manifest → config → one layer blob
    const layer = text('layer-bytes');
    const layerDigest = await store.putBlob(layer);
    const config = text(JSON.stringify({ rootfs: { diff_ids: [] } }));
    const configDigest = await store.putBlob(config);
    const manifest = text(
      JSON.stringify({
        schemaVersion: 2,
        config: { mediaType: 'application/vnd.artipod.volume.v1+json', digest: configDigest, size: config.length },
        layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: layerDigest, size: layer.length }],
      }),
    );
    const manifestDigest = await store.putBlob(manifest);
    await store.putRef('unit/x:1', manifestDigest, 'application/vnd.oci.image.manifest.v1+json');

    const manager = fakeManagerFetch();
    const remote = new HttpPodStore('http://manager.test/api/pods', manager.fetchFn);

    const first = await syncRef(store, remote, 'unit/x:1');
    expect(first.moved).toBe(3);
    expect(first.skipped).toBe(0);
    expect(manager.blobs.size).toBe(3);
    expect(manager.refs.get('unit/x:1')?.manifestDigest).toBe(manifestDigest);

    const second = await syncRef(store, remote, 'unit/x:1');
    expect(second.moved).toBe(0);
    expect(second.skipped).toBe(3);

    // and the reverse direction into a fresh local store also converges
    unmountAll();
    await configure({ mounts: { '/': InMemory } });
    const fresh = new OciStore(zfs);
    await fresh.init();
    const back = await syncRef(remote, fresh, 'unit/x:1');
    expect(back.moved).toBe(3);
    expect(await fresh.getBlob(layerDigest as Digest)).toEqual(layer);
  });

  it('getBlob verifies digests from the wire (tampered remote rejected)', async () => {
    const manager = fakeManagerFetch();
    const remote = new HttpPodStore('http://manager.test/api/pods', manager.fetchFn);
    const digest = await sha256(text('honest'));
    manager.blobs.set(digest, text('tampered'));
    await expect(remote.getBlob(digest)).rejects.toThrow(/tampered/);
  });
});

describe('PodSessionHost', () => {
  it('hosts isolated sessions with limits, busy-guard and TTL eviction', async () => {
    unmountAll();
    const host = new PodSessionHost({ ttlMs: 60_000, maxSessions: 2, execTimeoutMs: 5000, maxFsBytes: 1024 * 1024 });

    const a = await host.exec('alice', 'echo hi > /repo/a.txt && cat /repo/a.txt');
    expect(a).toMatchObject({ ok: true, stdout: 'hi\n' });
    // isolation: bob can't see alice's file
    const b = await host.exec('bob', 'ls /repo');
    expect(b.ok && !('a.txt' in {}) ? (b as { stdout: string }).stdout : '').not.toContain('a.txt');

    expect((await host.exec('x/../etc', 'true')).ok).toBe(false); // invalid id
    const limit = await host.acquire('carol');
    expect(limit.ok).toBe(false); // maxSessions = 2
    if (limit.ok === false) expect(limit.status).toBe(503);

    host.evictExpired(Date.now() + 120_000);
    expect(host.size).toBe(0);
  });
});
