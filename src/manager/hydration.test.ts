/**
 * Phase 6.6 units: bandwidth lanes (interactive preempts prefetch), Range
 * resume math, the LAN pull-through cache (zero-WAN second pull; ciphertext
 * only for encrypted pods), and path globs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import type { PodFs } from '../podfs.js';
import type { ZenFsLike } from '../sandbox/types.js';
import { OciStore } from '../oci/store.js';
import { sha256 } from '../oci/digest.js';
import { isEncryptedBlob } from '../oci/cipher.js';
import { OciLayoutPodStore } from './pod-store.js';
import type { PodStore } from './pod-store.js';
import { Authority } from './authority.js';
import { pushEncryptedRef, pullEncryptedRef } from './encrypted-sync.js';
import { bindContext } from '@zenfs/core';
import {
  BandwidthScheduler,
  CachingPodStore,
  fetchBlobResumable,
  persistPartial,
  pathGlobMatch,
} from './hydration.js';

const text = (s: string) => new TextEncoder().encode(s);

function unmountAll() {
  for (const path of [...zenMounts.keys()]) {
    if (path !== '/') umount(path);
  }
  try {
    umount('/');
  } catch {
    // first run
  }
}

/** PodStore wrapper counting blob reads — the "WAN" in cache tests. */
function counting(store: PodStore): PodStore & { blobReads: Map<string, number> } {
  const blobReads = new Map<string, number>();
  return {
    blobReads,
    hasBlob: (d) => store.hasBlob(d),
    async getBlob(d) {
      blobReads.set(d, (blobReads.get(d) ?? 0) + 1);
      return store.getBlob(d);
    },
    putBlob: (b, e) => store.putBlob(b, e),
    getRef: (r) => store.getRef(r),
    putRef: (r, m, mt) => store.putRef(r, m, mt),
    listRefs: () => store.listRefs(),
  };
}

beforeEach(async () => {
  unmountAll();
  await configure({ mounts: { '/': InMemory } });
});

describe('bandwidth lanes', () => {
  it('a queued interactive transfer preempts remaining prefetch work', async () => {
    const scheduler = new BandwidthScheduler();
    const gates: Record<string, () => void> = {};
    const gated = (name: string) =>
      new Promise<void>((resolve) => {
        gates[name] = resolve;
      });

    const p1 = scheduler.schedule('prefetch', () => gated('p1'), 'p1');
    const p2 = scheduler.schedule('prefetch', () => gated('p2'), 'p2');
    const p3 = scheduler.schedule('prefetch', () => gated('p3'), 'p3');
    await new Promise((r) => setTimeout(r, 0)); // p1 is now running
    const i1 = scheduler.schedule('interactive', () => gated('i1'), 'i1');
    await new Promise((r) => setTimeout(r, 0));

    gates.p1!();
    await p1;
    await new Promise((r) => setTimeout(r, 0));
    // The lane order decides what ran next: interactive, not p2.
    gates.i1!();
    await i1;
    gates.p2!();
    await p2;
    gates.p3!();
    await p3;

    expect(scheduler.log.map((t) => t.label)).toEqual(['p1', 'i1', 'p2', 'p3']);
  });
});

describe('byte-offset resume', () => {
  it('continues an interrupted download from the persisted offset and verifies the whole', async () => {
    const blob = text('x'.repeat(10_000));
    const digest = await sha256(blob);
    const requestedStarts: number[] = [];
    const fetchRange = async (start: number) => {
      requestedStarts.push(start);
      return blob.subarray(start);
    };

    // The first attempt died after 4 KiB — its partial was persisted.
    await persistPartial(zfs as unknown as ZenFsLike, digest, blob.subarray(0, 4096));
    const whole = await fetchBlobResumable({ digest, zfs: zfs as unknown as ZenFsLike, fetchRange });
    expect(requestedStarts).toEqual([4096]); // Range: bytes=4096-
    expect(whole).toEqual(blob);

    // A tampered remainder fails digest verification and keeps nothing.
    await persistPartial(zfs as unknown as ZenFsLike, digest, blob.subarray(0, 4096));
    const evil = async (start: number) => {
      const bytes = new Uint8Array(blob.subarray(start));
      bytes[0] ^= 0xff;
      return bytes;
    };
    await expect(fetchBlobResumable({ digest, zfs: zfs as unknown as ZenFsLike, fetchRange: evil })).rejects.toThrow(/digest/i);
  });
});

describe('site cache (LAN pull-through)', () => {
  it('second browser pulls with zero WAN blob fetches', async () => {
    // WAN origin with one blob + ref.
    await zfs.promises.mkdir('/wan', { recursive: true });
    const origin = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/wan');
    await origin.init();
    const payload = text('study payload');
    const digest = await origin.putBlob(payload);
    await origin.putRef('site:1', digest, 'application/octet-stream');
    const wan = counting(origin);

    await zfs.promises.mkdir('/site-cache', { recursive: true });
    const front = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/site-cache');
    await front.init();
    const cache = new CachingPodStore(front, wan);

    // Browser 1 warms the cache (one WAN fetch)…
    expect(await cache.getBlob(digest)).toEqual(payload);
    expect(wan.blobReads.get(digest)).toBe(1);
    // …browser 2 is LAN-only.
    expect(await cache.getBlob(digest)).toEqual(payload);
    expect(wan.blobReads.get(digest)).toBe(1);
    expect(cache.counters).toMatchObject({ frontHits: 1, originBlobFetches: 1 });
  });

  it('holds only ciphertext for an encrypted pod (blind cache)', async () => {
    const authority = await Authority.create('home-base');
    const kek = authority.registerPod('shared');
    const importKek = () =>
      crypto.subtle.importKey('raw', kek as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

    const src = new OciStore(zfs);
    await src.init();
    await src.enableEncryption(await importKek());
    const layer = text('PHI that must stay sealed on the cache box');
    const dLayer = await src.putBlob(layer);
    const config = text(JSON.stringify({ diff_ids: [dLayer] }));
    const dConfig = await src.putBlob(config);
    const manifest = text(
      JSON.stringify({
        schemaVersion: 2,
        config: { mediaType: 'application/vnd.artipod.volume.v1+json', digest: dConfig, size: config.length },
        layers: [{ mediaType: 'application/vnd.artipod.volume.layer.v1.chunked+encrypted', digest: dLayer, size: layer.length }],
      }),
    );
    const dManifest = await src.putBlob(manifest);
    await src.putRef('clinical:1', dManifest, 'application/vnd.oci.image.manifest.v1+json');

    await zfs.promises.mkdir('/shore-origin', { recursive: true });
    const origin = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/shore-origin');
    await origin.init();
    await pushEncryptedRef(src, origin, 'clinical:1', await importKek());

    await zfs.promises.mkdir('/lan-cache', { recursive: true });
    const front = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/lan-cache');
    await front.init();
    const cache = new CachingPodStore(front, counting(origin));

    // A LAN browser pulls THROUGH the cache with its key…
    await zfs.promises.mkdir('/lan-browser', { recursive: true });
    const ctx = bindContext({ root: '/lan-browser' });
    const dst = new OciStore(ctx.fs as unknown as ZenFsLike);
    await dst.init();
    await dst.enableEncryption(await importKek());
    await pullEncryptedRef(cache, dst, 'clinical:1', await importKek());
    expect(new TextDecoder().decode(await dst.getBlob(dLayer))).toContain('PHI');

    // …and the cache box never held a readable byte.
    const cached = (await zfs.promises.readdir('/lan-cache/blobs/sha256')) as string[];
    expect(cached.length).toBeGreaterThan(0);
    for (const name of cached) {
      const raw = (await zfs.promises.readFile(`/lan-cache/blobs/sha256/${name}`)) as Uint8Array;
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      expect(isEncryptedBlob(bytes)).toBe(true);
      expect(new TextDecoder().decode(bytes)).not.toContain('PHI');
    }
  });
});

describe('path globs', () => {
  it('** crosses directories, * does not, leading slash is ignored', () => {
    expect(pathGlobMatch('dicom/**', '/dicom/study1/a.bin')).toBe(true);
    expect(pathGlobMatch('dicom/*', '/dicom/study1/a.bin')).toBe(false);
    expect(pathGlobMatch('dicom/*', '/dicom/a.bin')).toBe(true);
    expect(pathGlobMatch('**/notes.md', '/deep/dir/notes.md')).toBe(true);
    expect(pathGlobMatch('notes.md', '/notes.md')).toBe(true);
    expect(pathGlobMatch('notes.md', '/repo/notes.md')).toBe(false);
  });
});
