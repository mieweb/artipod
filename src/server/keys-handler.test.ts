/**
 * S5.5 — key leases + encrypted publish. Order matters: the blind-host
 * regression comes FIRST (a keyless serve round-trips encrypted refs as
 * opaque ciphertext with zero broker code), then the /api/keys broker
 * surface, lease enforcement on the pods surface, and the browser
 * keyring flow under a fake clock.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts, bindContext } from '@zenfs/core';
import type { PodFs } from '../podfs.js';
import type { ZenFsLike } from '../sandbox/types.js';
import { OciStore } from '../oci/store.js';
import { sha256 } from '../oci/digest.js';
import { generateBlobKey, isEncryptedBlob } from '../oci/cipher.js';
import { OciLayoutPodStore } from '../manager/pod-store.js';
import { HttpPodStore } from '../manager/http-store.js';
import { pushEncryptedRef, pullEncryptedRef } from '../manager/encrypted-sync.js';
import { Authority, decodeLoginResult, verifyLease, type Lease, type WireLoginResult } from '../manager/authority.js';
import { toBase64 } from '../manager/crypto.js';
import { Keyring, PodLockedError } from '../manager/keyring.js';
import { PodLocker, kekName } from '../manager/locker.js';
import { createArtipodApp, type ArtipodApp } from './app.js';
import { staticTokenAuth } from './common.js';
import { LEASE_HEADER } from './keys-handler.js';

const base = 'http://keys.test';
const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

function unmountAll(): void {
  for (const path of [...zenMounts.keys()]) {
    if (path !== '/') umount(path);
  }
  try {
    umount('/');
  } catch {
    // first run
  }
}

beforeEach(async () => {
  unmountAll();
  await configure({ mounts: { '/': InMemory } });
});

/** HttpPodStore's fetch, routed straight into an app handler. */
const appFetch = (app: ArtipodApp): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => app(new Request(input as string | URL, init))) as typeof fetch;

/** A minimal encrypted image in `store` under `ref`; returns the layer digest. */
async function seedEncryptedImage(store: OciStore, ref: string, marker: string) {
  const layer = text(marker);
  const dLayer = await store.putBlob(layer);
  const config = text(JSON.stringify({ diff_ids: [dLayer] }));
  const dConfig = await store.putBlob(config);
  const manifest = text(
    JSON.stringify({
      schemaVersion: 2,
      config: { mediaType: 'application/vnd.artipod.volume.v1+json', digest: dConfig, size: config.length },
      layers: [{ mediaType: 'application/vnd.artipod.volume.layer.v1.chunked+encrypted', digest: dLayer, size: layer.length }],
    }),
  );
  const dManifest = await store.putBlob(manifest);
  await store.putRef(ref, dManifest, 'application/vnd.oci.image.manifest.v1+json');
  return dLayer;
}

const leaseHeader = (lease: Lease): string => toBase64(text(JSON.stringify(lease)));

describe('blind host (keyless serve, zero broker code)', () => {
  it('round-trips an encrypted ref as opaque ciphertext through the pods surface', async () => {
    // keyless server over an OCI-layout dir
    await zfs.promises.mkdir('/serve-store', { recursive: true });
    const serverStore = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/serve-store');
    await serverStore.init();
    const app = createArtipodApp({ store: serverStore });

    // encrypted client A pushes; the key never touches the server
    const key = await generateBlobKey();
    const src = new OciStore(zfs);
    await src.init();
    await src.enableEncryption(key);
    const marker = 'PHI the blind host must never read';
    const dLayer = await seedEncryptedImage(src, 'clinical:_1', marker);
    const relay = new HttpPodStore(`${base}/api/pods`, appFetch(app));
    await pushEncryptedRef(src, relay, 'clinical:_1', key);

    // client B (own store, out-of-band key) pulls and decrypts
    const ctx = bindContext({ root: '/client-b' });
    const dst = new OciStore(ctx.fs as unknown as ZenFsLike);
    await dst.init();
    await dst.enableEncryption(key);
    await pullEncryptedRef(relay, dst, 'clinical:_1', key);
    expect(decode(await dst.getBlob(dLayer))).toBe(marker);

    // the host held ciphertext only
    const blobs = (await zfs.promises.readdir('/serve-store/blobs/sha256')) as string[];
    expect(blobs.length).toBeGreaterThan(0);
    for (const name of blobs) {
      const raw = (await zfs.promises.readFile(`/serve-store/blobs/sha256/${name}`)) as Uint8Array;
      expect(decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))).not.toContain('PHI');
    }
    // and a plaintext-addressed read on the wire is refused, not leaked
    const res = await app(new Request(`${base}/api/pods/blobs/${dLayer}`));
    expect(res.status).toBe(404); // no alias on the host — the plain digest simply doesn't exist there
  });

  it('an encrypted OciLayoutPodStore without its key serves ciphertext digests but 423s plaintext ones', async () => {
    await zfs.promises.mkdir('/enc-store', { recursive: true });
    const writing = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/enc-store');
    await writing.init();
    writing.enableEncryption(await generateBlobKey());
    const bytes = text('sealed at rest');
    const digest = await writing.putBlob(bytes);
    expect(decode(await writing.getBlob(digest))).toBe('sealed at rest'); // key holder round-trips

    // reopen keyless (a second serve on the same dir)
    const keyless = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/enc-store');
    const app = createArtipodApp({ store: keyless });
    const res = await app(new Request(`${base}/api/pods/blobs/${digest}`));
    expect(res.status).toBe(423);
    expect(((await res.json()) as { error: string }).error).toContain('holds no key');
    // on-disk bytes are ciphertext
    const files = (await zfs.promises.readdir('/enc-store/blobs/sha256')) as string[];
    const blobFile = files.find((f) => !f.endsWith('.alias'))!;
    const raw = (await zfs.promises.readFile(`/enc-store/blobs/sha256/${blobFile}`)) as Uint8Array;
    expect(isEncryptedBlob(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))).toBe(true);
  });
});

describe('/api/keys (broker surface)', () => {
  async function brokerApp(opts: { auth?: boolean; enforce?: boolean; clock?: () => number } = {}) {
    const clock = opts.clock ?? Date.now;
    const authority = await Authority.create('test-authority', clock);
    const podId = 'pod-under-test';
    authority.registerPod(podId);
    await zfs.promises.mkdir('/broker-store', { recursive: true });
    const store = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/broker-store');
    await store.init();
    const app = createArtipodApp({
      store,
      auth: opts.auth ? staticTokenAuth({ rw: () => 'rw-secret', ro: () => 'ro-secret' }) : undefined,
      keys: { authority, podIds: [podId], capTtlMs: 60_000, enforce: opts.enforce, clock },
    });
    return { app, authority, podId };
  }

  it('404s when no authority is configured', async () => {
    await zfs.promises.mkdir('/plain-store', { recursive: true });
    const store = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/plain-store');
    await store.init();
    const app = createArtipodApp({ store });
    expect((await app(new Request(`${base}/api/keys`))).status).toBe(404);
    expect((await app(new Request(`${base}/api/keys/login`, { method: 'POST' }))).status).toBe(404);
  });

  it('GET / returns metadata only; login returns a verifiable lease + KEK, TTL clamped to the cap', async () => {
    const { app, authority, podId } = await brokerApp({ enforce: false });
    const meta = (await (await app(new Request(`${base}/api/keys`))).json()) as Record<string, unknown>;
    expect(meta).toMatchObject({ authority: 'test-authority', podIds: [podId], capTtlMs: 60_000 });
    expect(meta.publicKey).toBe(authority.publicKey);
    expect(meta.keys).toBeUndefined(); // metadata only — never key material

    const res = await app(
      new Request(`${base}/api/keys/login`, {
        method: 'POST',
        body: JSON.stringify({ principal: 'user:alice', ttlMs: 999_999_999 }),
      }),
    );
    expect(res.status).toBe(200);
    const wire = (await res.json()) as WireLoginResult;
    await expect(verifyLease(wire.lease, authority.publicKey)).resolves.toBeUndefined();
    expect(wire.lease.principal).toBe('user:alice');
    expect(Date.parse(wire.lease.expiresAt) - Date.parse(wire.lease.issuedAt)).toBe(60_000); // clamped
    const { keys } = decodeLoginResult(wire);
    expect(keys[podId]).toHaveLength(32);
  });

  it('refuses pods it does not broker, and clamps an ro identity to a read-only lease', async () => {
    const { app } = await brokerApp({ auth: true, enforce: false });
    const authz = { authorization: 'Bearer ro-secret' };
    const outside = await app(
      new Request(`${base}/api/keys/login`, { method: 'POST', headers: authz, body: JSON.stringify({ podIds: ['other-pod'] }) }),
    );
    expect(outside.status).toBe(403);

    expect((await app(new Request(`${base}/api/keys/login`, { method: 'POST' }))).status).toBe(401); // no token
    const ro = (await (
      await app(new Request(`${base}/api/keys/login`, { method: 'POST', headers: authz }))
    ).json()) as WireLoginResult;
    expect(ro.lease.permissions).toEqual(['mount', 'read']);
    const rw = (await (
      await app(new Request(`${base}/api/keys/login`, { method: 'POST', headers: { authorization: 'Bearer rw-secret' } }))
    ).json()) as WireLoginResult;
    expect(rw.lease.permissions).toEqual(['mount', 'read', 'write']);
  });

  it('lease enforcement: refs read open, blobs and ref writes gated, /v2 off', async () => {
    let now = 1_000_000;
    const clock = () => now;
    const { app, authority, podId } = await brokerApp({ clock });
    const bytes = text('gated bytes');
    const digest = await sha256(bytes);

    // no lease: refs list open, blob read/write and ref write 401 with a hint
    expect((await app(new Request(`${base}/api/pods/refs`))).status).toBe(200);
    const denied = await app(new Request(`${base}/api/pods/blobs/${digest}`));
    expect(denied.status).toBe(401);
    expect(((await denied.json()) as { hint: string }).hint).toContain('/api/keys/login');
    expect((await app(new Request(`${base}/api/pods/blobs/${digest}`, { method: 'PUT', body: bytes }))).status).toBe(401);
    expect(
      (await app(new Request(`${base}/api/pods/blobs/${digest}`, { headers: { [LEASE_HEADER]: 'not-base64-json' } }))).status,
    ).toBe(401);

    // /v2 is off in broker mode
    expect((await app(new Request(`${base}/v2/`))).status).toBe(403);

    // rw lease passes writes and reads
    const { lease } = await authority.login({ principal: 'user:alice', podIds: [podId], ttlMs: 60_000 });
    const withLease = { [LEASE_HEADER]: leaseHeader(lease) };
    expect(
      (await app(new Request(`${base}/api/pods/blobs/${digest}`, { method: 'PUT', headers: withLease, body: bytes }))).status,
    ).toBe(201);
    expect((await app(new Request(`${base}/api/pods/blobs/${digest}`, { headers: withLease }))).status).toBe(200);

    // read-only lease: reads yes, writes 403
    const ro = await authority.login({ principal: 'user:bob', podIds: [podId], ttlMs: 60_000, permissions: ['mount', 'read'] });
    const roHeaders = { [LEASE_HEADER]: leaseHeader(ro.lease) };
    expect((await app(new Request(`${base}/api/pods/blobs/${digest}`, { headers: roHeaders }))).status).toBe(200);
    const roWrite = await app(new Request(`${base}/api/pods/blobs/${digest}`, { method: 'PUT', headers: roHeaders, body: bytes }));
    expect(roWrite.status).toBe(403);

    // a lease for some other pod does not cover this store
    const foreignAuthority = await Authority.create('elsewhere', clock);
    foreignAuthority.registerPod(podId); // same pod, WRONG signer
    const forged = await foreignAuthority.login({ principal: 'user:eve', podIds: [podId], ttlMs: 60_000 });
    expect(
      (await app(new Request(`${base}/api/pods/blobs/${digest}`, { headers: { [LEASE_HEADER]: leaseHeader(forged.lease) } })))
        .status,
    ).toBe(401);

    // expiry: the same lease dies when the clock passes it, with a re-login hint
    now += 61_000;
    const expired = await app(new Request(`${base}/api/pods/blobs/${digest}`, { headers: withLease }));
    expect(expired.status).toBe(401);
    expect(((await expired.json()) as { hint: string }).hint).toContain('re-login');
  });
});

describe('browser flow (keyring custody under a fake clock)', () => {
  it('login → adoptLogin → encrypted read/write; expiry locks; re-login restores', async () => {
    let now = 5_000_000;
    const clock = () => now;
    const authority = await Authority.create('home', clock);
    const podId = 'browser-pod';
    authority.registerPod(podId);
    await zfs.promises.mkdir('/broker2', { recursive: true });
    const serverStore = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/broker2');
    await serverStore.init();
    const app = createArtipodApp({ store: serverStore, keys: { authority, podIds: [podId], capTtlMs: 30_000, clock } });

    const login = async () => {
      const res = await app(new Request(`${base}/api/keys/login`, { method: 'POST', body: JSON.stringify({ principal: 'user:tab' }) }));
      expect(res.status).toBe(200);
      return decodeLoginResult((await res.json()) as WireLoginResult);
    };

    // the browser side: keyring custody over its own encrypted store
    const ctx = bindContext({ root: '/browser' });
    const local = new OciStore(ctx.fs as unknown as ZenFsLike);
    await local.init();
    const keyring = new Keyring(clock);
    const locker = new PodLocker({ keyring, stores: new Map([[podId, local]]), clock });
    await locker.adoptLogin(await login());
    await locker.bind(podId); // encryption-at-rest keyed off the keyring

    const digest = await local.putBlob(text('typed in the browser'));
    expect(decode(await local.getBlob(digest))).toBe('typed in the browser');
    // at rest it is ciphertext
    expect(keyring.has(kekName(podId))).toBe(true);

    // TTL passes: the key evaporates — reads throw PodLockedError
    now += 31_000;
    expect(keyring.has(kekName(podId))).toBe(false);
    await expect(local.getBlob(digest)).rejects.toThrow(PodLockedError);

    // re-login restores the same content without any rewrite
    await locker.adoptLogin(await login());
    expect(decode(await local.getBlob(digest))).toBe('typed in the browser');
  });
});
