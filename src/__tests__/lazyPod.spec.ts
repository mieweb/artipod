/**
 * Phase 6.6 end-to-end — the driving use case: one pod per patient, visit
 * notes eager, DICOM on demand. Covers the done-when bullets through the
 * shell: index-level pull moves only metadata; the full namespace lists at
 * near-zero storage; opening a placeholder fetches exactly ONE layer blob;
 * grep across dehydrated trees fetches NOTHING; commit --layer-group
 * annotates dedicated lazy layers; dehydrate round-trips; the agent
 * prefetch tool warms layers visibly in /proc/hydration; foreign images
 * without indexes degrade gracefully to a full pull.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import type { PodFs } from '../podfs.js';
import { createZenFsPod } from '../realize/zenfs.js';
import { OciLayoutPodStore } from '../manager/pod-store.js';
import type { PodStore } from '../manager/pod-store.js';
import type { StoredRef } from '../oci/store.js';
import { sha256, type Digest } from '../oci/digest.js';
import { syncRef } from '../manager/sync.js';
import { ANNOTATION_HYDRATION, ANNOTATION_LAYER_GROUP, ANNOTATION_LAYER_INDEX } from '../manager/hydration.js';
import { gzip } from '../oci/gzip.js';
import { writeTar } from '../oci/tar.js';
import type { PodManifest } from '../manifest.js';

const manifest = (tag: string): PodManifest => ({
  formatVersion: 1,
  mounts: [{ name: `root-${tag}`, path: '/', mode: 'rw', source: { kind: 'backend', backend: 'memory' } }],
});

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

/** A WAN manager that survives filesystem resets — plain Maps. */
function memStore(): PodStore {
  const blobs = new Map<string, Uint8Array>();
  const refs = new Map<string, StoredRef>();
  return {
    hasBlob: async (d) => blobs.has(d),
    async getBlob(d) {
      const b = blobs.get(d);
      if (!b) throw new Error(`mem store: no blob ${d}`);
      return b;
    },
    async putBlob(bytes, expected) {
      const digest = expected ?? (await sha256(bytes));
      blobs.set(digest, new Uint8Array(bytes));
      return digest as Digest;
    },
    getRef: async (r) => refs.get(r) ?? null,
    async putRef(ref, manifestDigest, mediaType) {
      refs.set(ref, { ref, manifestDigest, mediaType, pulledAt: new Date().toISOString() });
    },
    listRefs: async () => [...refs.values()],
  };
}

/** Blob-read counting wrapper — the WAN meter for the transfer assertions. */
function counting(store: PodStore): PodStore & { blobReads: Map<string, number>; totalReads: () => number } {
  const blobReads = new Map<string, number>();
  return {
    blobReads,
    totalReads: () => [...blobReads.values()].reduce((a, b) => a + b, 0),
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

describe('lazy hydration, end to end', () => {
  beforeEach(async () => {
    unmountAll();
    await configure({ mounts: { '/': InMemory } });
  });

  it('commit groups → index pull → placeholders → hydrate one study → dehydrate round-trip → prefetch tool', async () => {
    // --- the clinic workstation commits the patient record ---------------
    await zfs.promises.mkdir('/repo', { recursive: true });
    const podA = await createZenFsPod(manifest('clinic'), { adopt: zfs, cwd: '/repo' });
    const shellA = podA.createSandbox();
    await shellA.exec('echo "visit notes: bp 120/80, follow up in 2w" > /notes.md');
    await shellA.exec('mkdir -p /dicom/study1 /dicom/study2');
    // "Imaging": distinctive payloads on the lazy path.
    await shellA.exec('echo "CT-SLICE-STUDY-ONE imaging payload, series 1 of 1, 512x512" > /dicom/study1/a.bin');
    await shellA.exec('echo "MR-SLICE-STUDY-TWO imaging payload, series 1 of 1, 256x256" > /dicom/study2/b.bin');

    const commit = await shellA.exec(
      "artipod commit --tag patient/rec:1 --layer-group 'dicom/study1/**' --layer-group 'dicom/study2/**'",
    );
    expect(commit.exitCode).toBe(0);
    expect(commit.stdout).toContain('layers: 3');

    // Done-when: the manifest carries dedicated lazy layers with annotations.
    const stored = (await podA.oci.store.getRef('patient/rec:1'))!;
    const manifestJson = JSON.parse(new TextDecoder().decode(await podA.oci.store.getBlob(stored.manifestDigest))) as {
      layers: { size: number; annotations?: Record<string, string> }[];
    };
    expect(manifestJson.layers).toHaveLength(3);
    expect(manifestJson.layers[0].annotations?.[ANNOTATION_HYDRATION]).toBeUndefined();
    for (const [i, glob] of [['1', 'dicom/study1/**'], ['2', 'dicom/study2/**']] as const) {
      const layer = manifestJson.layers[Number(i)];
      expect(layer.annotations?.[ANNOTATION_HYDRATION]).toBe('lazy');
      expect(layer.annotations?.[ANNOTATION_LAYER_GROUP]).toBe(glob);
      expect(layer.annotations?.[ANNOTATION_LAYER_INDEX]).toMatch(/^sha256:/);
    }
    const lazyLayerDigests = manifestJson.layers.slice(1).map((l, i) => ({
      digest: (manifestJson.layers[i + 1] as { digest?: string }).digest as string,
      size: l.size,
    }));

    // Push everything to the deployment's manager store (the "WAN").
    const wanStore = memStore();
    await syncRef(podA.oci.store, wanStore, 'patient/rec:1');
    podA.dispose();

    // --- the tablet in the exam room: fresh device, index-level pull -----
    unmountAll();
    await configure({ mounts: { '/': InMemory } });
    await zfs.promises.mkdir('/repo', { recursive: true });
    const wan = counting(wanStore);
    const podB = await createZenFsPod(manifest('tablet'), {
      adopt: zfs,
      cwd: '/repo',
      sync: { remote: wan },
      // The exam-room profile: everything lazy except the visit notes.
      hydration: { defaultRef: 'patient/rec:1', policy: { default: 'lazy', eager: ['notes.md'] } },
    });
    const shellB = podB.createSandbox();

    const pull = await shellB.exec('artipod image pull patient/rec:1 --index');
    expect(pull.stderr).toBe('');
    expect(pull.exitCode).toBe(0);
    expect(pull.stdout).toContain('2 placeholder');
    // Done-when: only metadata moved — neither imaging blob crossed the wire.
    for (const lazy of lazyLayerDigests) {
      expect(wan.blobReads.get(lazy.digest) ?? 0).toBe(0);
    }
    // Byte counters: metadata only — manifest, config, eager notes layer and
    // the two published indexes; far below the imaging payload sizes.
    const metadataReads = wan.totalReads();
    expect(metadataReads).toBeGreaterThan(0);
    expect(metadataReads).toBeLessThanOrEqual(6);

    // Full namespace at near-zero storage: ls + stat serve from the index.
    expect((await shellB.exec('artipod image mount patient/rec:1 /mnt/rec')).stdout).toContain('2 dehydrated');
    const lsRoot = await shellB.exec('ls /mnt/rec');
    expect(lsRoot.stderr).toBe('');
    expect(lsRoot.stdout).toContain('notes.md');
    const ls = await shellB.exec('ls /mnt/rec/dicom/study1');
    expect(ls.stderr).toBe('');
    expect(ls.stdout).toContain('a.bin');
    // Eager main layer content reads normally.
    expect((await shellB.exec('cat /mnt/rec/notes.md')).stdout).toContain('bp 120/80');

    // Done-when: a dehydrated read fails FAST. (just-bash's cat prints its
    // own generic message for any read error; the structured hint rides the
    // fs error into the file tools + editor surfaces, asserted below.)
    const coldRead = await shellB.exec('cat /mnt/rec/dicom/study1/a.bin');
    expect(coldRead.exitCode).not.toBe(0);
    const earlyTools = podB.createAgentTools(shellB);
    const coldToolRead = await earlyTools.get('read_file')!.execute({ filePath: '/mnt/rec/dicom/study1/a.bin' }, undefined as never);
    expect(coldToolRead.success).toBe(false);
    expect(coldToolRead.error).toContain('artipod hydrate');

    // Done-when: grep -r across the dehydrated tree triggers ZERO fetches.
    const before = wan.totalReads();
    const grep = await shellB.exec('grep -r CT-SLICE /mnt/rec || true');
    expect(grep.stdout).not.toContain('CT-SLICE-STUDY-ONE');
    expect(wan.totalReads()).toBe(before);

    // Done-when: hydrating study1 fetches EXACTLY ONE layer blob.
    const hydrate = await shellB.exec("artipod hydrate patient/rec:1 'dicom/study1/**'");
    expect(hydrate.exitCode).toBe(0);
    expect(hydrate.stdout).toContain('hydrated 1 layer(s)');
    expect(wan.totalReads()).toBe(before + 1);
    expect(wan.blobReads.get(lazyLayerDigests[0].digest)).toBe(1);
    // …digest verified on the way in (putBlob), content opens now:
    expect((await shellB.exec('cat /mnt/rec/dicom/study1/a.bin')).stdout).toContain('CT-SLICE-STUDY-ONE');
    // study2 untouched.
    expect(wan.blobReads.get(lazyLayerDigests[1].digest) ?? 0).toBe(0);

    // Done-when: dehydrate evicts blobs, keeps placeholders; round-trips.
    const dehydrate = await shellB.exec("artipod dehydrate patient/rec:1 'dicom/study1/**'");
    expect(dehydrate.exitCode).toBe(0);
    expect((await shellB.exec('ls /mnt/rec/dicom/study1')).stdout).toContain('a.bin'); // index stays
    const evicted = await shellB.exec('cat /mnt/rec/dicom/study1/a.bin');
    expect(evicted.exitCode).not.toBe(0); // fail fast again (hint contract asserted above)
    await shellB.exec("artipod hydrate patient/rec:1 'dicom/study1/**'");
    expect((await shellB.exec('cat /mnt/rec/dicom/study1/a.bin')).stdout).toContain('CT-SLICE-STUDY-ONE');

    // Done-when: the agent prefetch tool warms study2 inside the prefetch
    // lane and the state is visible in /proc/hydration.
    const tools = podB.createAgentTools(shellB);
    const prefetch = tools.get('prefetch')!;
    const result = await prefetch.execute({ paths: ['dicom/study2/**'] }, undefined as never);
    expect(result.success).toBe(true);
    expect(wan.blobReads.get(lazyLayerDigests[1].digest)).toBe(1);
    const proc = await shellB.exec('cat /proc/hydration/state.json');
    expect(proc.stdout).toContain('"state": "hydrated"');
    expect(proc.stdout).not.toContain('"state": "placeholder"');
    expect((await shellB.exec('cat /mnt/rec/dicom/study2/b.bin')).stdout).toContain('MR-SLICE-STUDY-TWO');

    podB.dispose();
  });

  it('a foreign image without published indexes degrades gracefully to a full pull', async () => {
    // Hand-build a bare OCI image (no artipod annotations) on the "WAN".
    await zfs.promises.mkdir('/wan-foreign', { recursive: true });
    const wanStore = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/wan-foreign');
    await wanStore.init();
    const tar = writeTar([{ path: '/hello.txt', type: 'file', content: new TextEncoder().encode('from a plain registry') }]);
    const diffId = await sha256(tar);
    const compressed = await gzip(tar);
    const layerDigest = await wanStore.putBlob(compressed);
    const config = new TextEncoder().encode(JSON.stringify({ rootfs: { type: 'layers', diff_ids: [diffId] } }));
    const configDigest = await wanStore.putBlob(config);
    const manifestBytes = new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: config.length },
        layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: layerDigest, size: compressed.length }],
      }),
    );
    const manifestDigest = await wanStore.putBlob(manifestBytes);
    await wanStore.putRef('foreign:1', manifestDigest, 'application/vnd.oci.image.manifest.v1+json');

    await zfs.promises.mkdir('/repo', { recursive: true });
    const pod = await createZenFsPod(manifest('foreign'), {
      adopt: zfs,
      cwd: '/repo',
      sync: { remote: wanStore },
      hydration: {},
    });
    const shell = pod.createSandbox();
    const pull = await shell.exec('artipod image pull foreign:1 --index');
    expect(pull.exitCode).toBe(0);
    expect(pull.stdout).toContain('0 placeholder'); // degraded to full — documented behavior
    const state = await pod.hydrator!.stateFor('foreign:1');
    expect(state!.layers[0]).toMatchObject({ state: 'hydrated', degraded: true });
    await shell.exec('artipod image mount foreign:1 /mnt/foreign');
    expect((await shell.exec('cat /mnt/foreign/hello.txt')).stdout).toContain('from a plain registry');
    pod.dispose();
  });
});
