/**
 * publishDirectory: per-file layers with published indexes and LWW
 * annotations (sync plan Phase C) — determinism, CAS reuse on republish,
 * grouping, ignores, and the done-when: an index-level pull lists the
 * whole tree while moving ZERO layer blobs.
 */
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import { sha256, type Digest } from '../oci/digest.js';
import type { StoredRef } from '../oci/store.js';
import type { ImageManifest } from '../oci/pull.js';
import { ANNOTATION_HYDRATION, ANNOTATION_LAYER_GROUP, ANNOTATION_LAYER_INDEX } from '../oci/tar.js';
import type { PodStore } from '../manager/pod-store.js';
import { createZenFsPod } from '../realize/zenfs.js';
import type { PodManifest } from '../manifest.js';
import {
  ANNOTATION_ACTOR,
  ANNOTATION_MTIME,
  ANNOTATION_PARENTS,
  ANNOTATION_PATH,
  publishDirectory,
} from './folder.js';

function memStore(): PodStore & { blobReads: Map<string, number>; totalReads: () => number } {
  const blobs = new Map<string, Uint8Array>();
  const refs = new Map<string, StoredRef>();
  const blobReads = new Map<string, number>();
  return {
    blobReads,
    totalReads: () => [...blobReads.values()].reduce((a, b) => a + b, 0),
    hasBlob: async (d) => blobs.has(d),
    async getBlob(d) {
      blobReads.set(d, (blobReads.get(d) ?? 0) + 1);
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

const decoder = new TextDecoder();
async function manifestOf(store: PodStore, ref: string): Promise<ImageManifest> {
  const head = (await store.getRef(ref))!;
  return JSON.parse(decoder.decode(await store.getBlob(head.manifestDigest))) as ImageManifest;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'publish-'));
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'readme.md'), 'hello folder pod\n');
  await writeFile(join(dir, 'docs', 'a.md'), 'alpha\n');
  await writeFile(join(dir, 'docs', 'b.md'), 'beta\n');
  // Fixed mtimes: they are the LWW clock AND the determinism input.
  const t = new Date('2026-08-30T12:00:00Z');
  for (const f of ['readme.md', 'docs/a.md', 'docs/b.md']) await utimes(join(dir, f), t, t);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('publishDirectory', () => {
  it('one layer per file, each with a published index and LWW annotations', async () => {
    const store = memStore();
    const result = await publishDirectory(store, dir, 'folder/demo:latest', { actor: 'server:test' });

    expect(result.layers).toBe(3);
    expect(result.reusedLayers).toBe(0);
    expect(result.unchanged).toBe(false);

    const manifest = await manifestOf(store, 'folder/demo:latest');
    expect(manifest.layers).toHaveLength(3);
    const paths = manifest.layers.map((l) => l.annotations?.[ANNOTATION_PATH]);
    expect(paths).toEqual(['/docs/a.md', '/docs/b.md', '/readme.md']); // canonical order
    for (const layer of manifest.layers) {
      expect(layer.annotations?.[ANNOTATION_HYDRATION]).toBe('lazy');
      expect(layer.annotations?.[ANNOTATION_LAYER_INDEX]).toMatch(/^sha256:/);
      expect(layer.annotations?.[ANNOTATION_ACTOR]).toBe('server:test');
      expect(Number(layer.annotations?.[ANNOTATION_MTIME])).toBe(new Date('2026-08-30T12:00:00Z').getTime());
    }
    expect(manifest.annotations?.[ANNOTATION_PARENTS]).toBeUndefined(); // first head
  });

  it('republish unchanged = no-op; touch one file = one new layer + parents link', async () => {
    const store = memStore();
    const first = await publishDirectory(store, dir, 'folder/demo:latest', { actor: 'server:test' });

    const again = await publishDirectory(store, dir, 'folder/demo:latest', { actor: 'server:test' });
    expect(again.unchanged).toBe(true);
    expect(again.manifestDigest).toBe(first.manifestDigest);
    expect(again.reusedLayers).toBe(3);
    expect(again.bytes).toBe(0);

    await writeFile(join(dir, 'docs', 'a.md'), 'alpha v2\n');
    const third = await publishDirectory(store, dir, 'folder/demo:latest', { actor: 'server:test' });
    expect(third.unchanged).toBe(false);
    expect(third.reusedLayers).toBe(2); // b.md + readme.md blobs reused
    const manifest = await manifestOf(store, 'folder/demo:latest');
    expect(JSON.parse(manifest.annotations![ANNOTATION_PARENTS]!)).toEqual([first.manifestDigest]);
  });

  it('groups matching files into one annotated layer; honors ignores; skips symlinks with a warning', async () => {
    await mkdir(join(dir, 'node_modules', 'x'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'x', 'index.js'), 'skip me');
    await symlink('/etc/hosts', join(dir, 'link'));

    const store = memStore();
    const result = await publishDirectory(store, dir, 'folder/demo:latest', {
      actor: 'server:test',
      group: ['docs/**'],
    });

    expect(result.layers).toBe(2); // docs group + readme
    expect(result.warnings.some((w) => w.includes('symlink skipped: link'))).toBe(true);

    const manifest = await manifestOf(store, 'folder/demo:latest');
    const group = manifest.layers.find((l) => l.annotations?.[ANNOTATION_LAYER_GROUP]);
    expect(group?.annotations?.[ANNOTATION_LAYER_GROUP]).toBe('docs/**');
    const indexDigest = group!.annotations![ANNOTATION_LAYER_INDEX] as Digest;
    const index = JSON.parse(decoder.decode(await store.getBlob(indexDigest))) as {
      entries: { path: string }[];
    };
    expect(index.entries.map((e) => e.path).sort()).toEqual(['/docs/a.md', '/docs/b.md']); // indexes are pod-absolute
    for (const layer of manifest.layers) {
      const idx = JSON.parse(decoder.decode(await store.getBlob(layer.annotations![ANNOTATION_LAYER_INDEX] as Digest))) as {
        entries: { path: string }[];
      };
      expect(idx.entries.every((e) => !e.path.includes('node_modules'))).toBe(true);
    }
  });

  it('done-when: a pod index-pulls the published folder and lists the whole tree with zero layer fetches', async () => {
    const remote = memStore();
    await publishDirectory(remote, dir, 'folder/demo:latest', { actor: 'server:test' });
    const manifest = await manifestOf(remote, 'folder/demo:latest');
    const layerDigests = new Set(manifest.layers.map((l) => l.digest));
    remote.blobReads.clear();

    for (const path of [...zenMounts.keys()]) if (path !== '/') umount(path);
    try {
      umount('/');
    } catch {
      // fine — fresh process
    }
    await configure({ mounts: { '/': InMemory } });
    await zfs.promises.mkdir('/repo', { recursive: true });
    const podManifest: PodManifest = {
      formatVersion: 1,
      mounts: [{ name: 'root', path: '/', mode: 'rw', source: { kind: 'backend', backend: 'memory' } }],
    };
    const pod = await createZenFsPod(podManifest, {
      adopt: zfs,
      cwd: '/repo',
      sync: { remote },
      hydration: { policy: { default: 'lazy' } },
    });
    const shell = pod.createSandbox();

    const pull = await shell.exec('artipod image pull folder/demo:latest --index');
    expect(pull.exitCode, pull.stderr).toBe(0);

    const mount = await shell.exec('artipod image mount folder/demo:latest /basis && find /basis -type f | sort');
    expect(mount.exitCode).toBe(0);
    expect(mount.stdout).toContain('/basis/docs/a.md');
    expect(mount.stdout).toContain('/basis/docs/b.md');
    expect(mount.stdout).toContain('/basis/readme.md');

    // The WAN meter: manifest/config/indexes moved; layer blobs did NOT.
    for (const [digest, reads] of remote.blobReads) {
      expect(layerDigests.has(digest as Digest), `layer blob ${digest} fetched during index pull (${reads}x)`).toBe(false);
    }
  });
});
