/**
 * Sync plan Phase D — the demo scenario, sentences 1–4 (§1): pick a
 * published artipod as a basis; the client opens a NEW LAYER on top; `find`
 * sees every file with nothing transferred; `cat` fetches exactly that
 * file's layer and caches it; writes land in the overlay.
 */
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import { sha256, type Digest } from '../oci/digest.js';
import type { StoredRef } from '../oci/store.js';
import type { ImageManifest } from '../oci/pull.js';
import type { PodStore } from '../manager/pod-store.js';
import { createZenFsPod } from '../realize/zenfs.js';
import type { PodManifest } from '../manifest.js';
import { publishDirectory } from '../server/folder.js';

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

const podManifest: PodManifest = {
  formatVersion: 1,
  mounts: [{ name: 'root', path: '/', mode: 'rw', source: { kind: 'backend', backend: 'memory' } }],
};

let dir: string;
let remote: ReturnType<typeof memStore>;
let layerDigests: Set<string>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'basis-'));
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'readme.md'), 'welcome to the folder pod\n');
  await writeFile(join(dir, 'docs', 'a.md'), 'alpha content\n');
  await writeFile(join(dir, 'docs', 'b.md'), 'beta content\n');
  const t = new Date('2026-08-30T12:00:00Z');
  for (const f of ['readme.md', 'docs/a.md', 'docs/b.md']) await utimes(join(dir, f), t, t);

  remote = memStore();
  await publishDirectory(remote, dir, 'folder/demo:latest', { actor: 'server:test' });
  const head = (await remote.getRef('folder/demo:latest'))!;
  const manifest = JSON.parse(new TextDecoder().decode(await remote.getBlob(head.manifestDigest))) as ImageManifest;
  layerDigests = new Set(manifest.layers.map((l) => l.digest));

  for (const path of [...zenMounts.keys()]) if (path !== '/') umount(path);
  try {
    umount('/');
  } catch {
    // fresh process
  }
  await configure({ mounts: { '/': InMemory } });
  await zfs.promises.mkdir('/repo', { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const layerReads = () =>
  [...remote.blobReads.entries()].filter(([d]) => layerDigests.has(d)).reduce((a, [, n]) => a + n, 0);

describe('open a published folder as a lazy basis (fetch-on-read)', () => {
  it('find = zero transfer; cat = exactly one layer; re-read cached; writes land in the overlay', async () => {
    const pod = await createZenFsPod(podManifest, {
      adopt: zfs,
      cwd: '/repo',
      sync: { remote },
      hydration: { policy: { default: 'lazy' }, onDemand: 'fetch' },
    });
    const shell = pod.createSandbox();

    const open = await shell.exec('artipod open folder/demo:latest /work');
    expect(open.stderr).toBe('');
    expect(open.stdout).toContain('opened folder/demo:latest at /work');
    expect(open.stdout).toContain('3 file(s) still remote');

    remote.blobReads.clear();

    // Sentence 3: find sees every file, nothing transferred.
    const find = await shell.exec('find /work -type f | sort');
    expect(find.stdout.trim().split('\n')).toEqual(['/work/docs/a.md', '/work/docs/b.md', '/work/readme.md']);
    expect(layerReads()).toBe(0);

    // Sentence 4: cat fetches exactly that file's layer…
    const cat = await shell.exec('cat /work/docs/a.md');
    expect(cat.stdout).toBe('alpha content\n');
    expect(cat.exitCode).toBe(0);
    expect(layerReads()).toBe(1);

    // …and caches it: a re-read moves nothing.
    const again = await shell.exec('cat /work/docs/a.md');
    expect(again.stdout).toBe('alpha content\n');
    expect(layerReads()).toBe(1);

    // The hydration ledger agrees: a.md local, the rest remote.
    const files = await shell.exec('artipod files');
    expect(files.stdout).toMatch(/local\s+\d+\s+\/docs\/a\.md/);
    expect(files.stdout).toMatch(/remote\s+\d+\s+\/docs\/b\.md/);
    expect(files.stdout).toMatch(/remote\s+\d+\s+\/readme\.md/);

    // Writes are the client's new layer-in-waiting (upper), zero transfer.
    const write = await shell.exec('echo "hi" > /work/testfile.txt && cat /work/testfile.txt');
    expect(write.stdout).toBe('hi\n');
    expect(write.exitCode).toBe(0);

    // Overwriting a basis file wins in the overlay (copy-up may hydrate — allowed).
    const overwrite = await shell.exec('echo "mine" > /work/docs/b.md && cat /work/docs/b.md');
    expect(overwrite.stdout).toBe('mine\n');

    // The untouched readme is still remote and still zero-fetched.
    const untouched = [...remote.blobReads.keys()].length;
    await shell.exec('ls -la /work && stat /work/readme.md');
    expect([...remote.blobReads.keys()].length).toBe(untouched);
  });

  it('sync.basis opens at boot and becomes the default cwd; onDemand default still fails fast', async () => {
    const pod = await createZenFsPod(podManifest, {
      adopt: zfs,
      sync: { remote, basis: { ref: 'folder/demo:latest' } },
      hydration: { policy: { default: 'lazy' }, onDemand: 'fetch' },
    });
    expect(pod.basis).toEqual({ ref: 'folder/demo:latest', at: '/open/folder_demo_latest' });
    const shell = pod.createSandbox();
    const pwd = await shell.exec('pwd && cat readme.md');
    expect(pwd.stdout).toBe('/open/folder_demo_latest\nwelcome to the folder pod\n');

    // The pinned zero-fetch default: a 'fail' pod's dehydrated reads error.
    for (const path of [...zenMounts.keys()]) if (path !== '/') umount(path);
    umount('/');
    await configure({ mounts: { '/': InMemory } });
    await zfs.promises.mkdir('/repo', { recursive: true });
    const failPod = await createZenFsPod(podManifest, {
      adopt: zfs,
      cwd: '/repo',
      sync: { remote },
      hydration: { policy: { default: 'lazy' } },
    });
    const failShell = failPod.createSandbox();
    await failShell.exec('artipod open folder/demo:latest /work');
    remote.blobReads.clear();
    const cat = await failShell.exec('cat /work/docs/a.md');
    expect(cat.exitCode).not.toBe(0);
    expect(layerReads()).toBe(0);
  });
});
