/**
 * Sync plan Phase E — write-back, §1 sentences 5–6: `echo hi > testfile.txt`
 * uploads a new layer, `rm` uploads a whiteout, the server materializes both
 * into the real folder (mtime round-trip ⇒ republish is a CAS no-op), and a
 * server-side edit flows back down while local overlay changes survive.
 */
import { lstat, mkdtemp, mkdir, readFile as nodeReadFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import { sha256, type Digest } from '../oci/digest.js';
import type { StoredRef } from '../oci/store.js';
import type { ImageManifest } from '../oci/pull.js';
import { buildFileLayer, ANNOTATION_ACTOR, ANNOTATION_OVERLAY, ANNOTATION_PATH, ANNOTATION_PARENTS } from '../oci/file-layer.js';
import type { PodStore } from '../manager/pod-store.js';
import { createZenFsPod } from '../realize/zenfs.js';
import type { PodManifest } from '../manifest.js';
import { publishDirectory, materializeRef } from '../server/folder.js';

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

const decoder = new TextDecoder();
async function headManifest(store: PodStore, ref: string): Promise<{ digest: Digest; manifest: ImageManifest }> {
  const head = (await store.getRef(ref))!;
  return { digest: head.manifestDigest, manifest: JSON.parse(decoder.decode(await store.getBlob(head.manifestDigest))) as ImageManifest };
}

const podManifest: PodManifest = {
  formatVersion: 1,
  mounts: [{ name: 'root', path: '/', mode: 'rw', source: { kind: 'backend', backend: 'memory' } }],
};

const REF = 'folder/demo:latest';
let dir: string;
let remote: PodStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'writeback-'));
  await mkdir(join(dir, 'docs'), { recursive: true });
  await writeFile(join(dir, 'readme.md'), 'welcome\n');
  await writeFile(join(dir, 'docs', 'a.md'), 'alpha v1\n');
  await writeFile(join(dir, 'docs', 'b.md'), 'beta v1\n');
  const t = new Date('2026-08-30T12:00:00Z');
  for (const f of ['readme.md', 'docs/a.md', 'docs/b.md']) await utimes(join(dir, f), t, t);
  remote = memStore();
  await publishDirectory(remote, dir, REF, { actor: 'server:test' });

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

const openPod = (autoPush: boolean | { debounceMs?: number } = false) =>
  createZenFsPod(podManifest, {
    adopt: zfs,
    sync: { remote, basis: { ref: REF, at: '/work' }, actor: 'browser:test', autoPush },
    hydration: { policy: { default: 'lazy' }, onDemand: 'fetch' },
  });

describe('overlay write-back', () => {
  it('echo uploads a layer, rm a whiteout; the server folder follows; republish is a CAS no-op', async () => {
    const { digest: originDigest, manifest: origin } = await headManifest(remote, REF);
    const pod = await openPod(false);
    const shell = pod.createSandbox();

    await shell.exec('echo hi > /work/testfile.txt');
    const push = await pod.pushBasis();
    expect(push?.pushed).toBe(true);

    const { manifest: pushed, digest: pushedDigest } = await headManifest(remote, REF);
    expect(pushed.layers).toHaveLength(origin.layers.length + 1);
    const overlayLayer = pushed.layers[pushed.layers.length - 1];
    expect(overlayLayer.annotations?.[ANNOTATION_PATH]).toBe('/testfile.txt');
    expect(overlayLayer.annotations?.[ANNOTATION_ACTOR]).toBe('browser:test');
    expect(overlayLayer.annotations?.[ANNOTATION_OVERLAY]).toBe('browser:test');
    expect(JSON.parse(pushed.annotations![ANNOTATION_PARENTS]!)).toEqual([originDigest]);
    // basis layers carried over verbatim — still lazy for other clients
    expect(pushed.layers.slice(0, origin.layers.length).map((l) => l.digest)).toEqual(origin.layers.map((l) => l.digest));

    // …and the real folder follows.
    const mat = await materializeRef(remote, REF, dir);
    expect(mat.written).toBe(1);
    expect(mat.deleted).toBe(0);
    expect(await nodeReadFile(join(dir, 'testfile.txt'), 'utf8')).toBe('hi\n');

    // Loop prevention: republish reuses every layer blob (mtime round-trip)…
    const republish = await publishDirectory(remote, dir, REF, { actor: 'server:test' });
    expect(republish.reusedLayers).toBe(republish.layers); // zero new layer bytes
    // …and once the head is canonical, publishing again is a full no-op.
    const again = await publishDirectory(remote, dir, REF, { actor: 'server:test' });
    expect(again.unchanged).toBe(true);

    // rm → whiteout → the file leaves the head but history keeps its blob.
    await shell.exec('artipod open folder/demo:latest /work'); // refresh onto the canonical head
    await shell.exec('rm /work/docs/b.md');
    const rmPush = await pod.pushBasis();
    expect(rmPush?.pushed).toBe(true);
    const matRm = await materializeRef(remote, REF, dir);
    expect(matRm.deleted).toBe(1);
    expect(existsSync(join(dir, 'docs', 'b.md'))).toBe(false);
    const bLayer = origin.layers.find((l) => l.annotations?.[ANNOTATION_PATH] === '/docs/b.md')!;
    expect(await remote.hasBlob(bLayer.digest)).toBe(true); // recoverable via parents
    expect(pushedDigest).not.toBe((await remote.getRef(REF))!.manifestDigest);
  });

  it('a server-side edit flows down on refresh; local overlay changes survive', async () => {
    const pod = await openPod(false);
    const shell = pod.createSandbox();
    await shell.exec('echo mine > /work/note.txt');
    await pod.pushBasis();

    // Server edits the folder and republishes.
    await materializeRef(remote, REF, dir); // bring note.txt down first so publish keeps it
    await writeFile(join(dir, 'docs', 'a.md'), 'alpha v2\n');
    await utimes(join(dir, 'docs', 'a.md'), new Date('2026-08-31T09:00:00Z'), new Date('2026-08-31T09:00:00Z'));
    await publishDirectory(remote, dir, REF, { actor: 'server:test' });

    // The open verb refreshes a moved head; the upper (and its files) survive.
    const reopen = await shell.exec('artipod open folder/demo:latest /work');
    expect(reopen.stdout).toContain('index-level pull');
    expect((await shell.exec('cat /work/docs/a.md')).stdout).toBe('alpha v2\n');
    expect((await shell.exec('cat /work/note.txt')).stdout).toBe('mine\n');
  });

  it('debounced auto-push fires after the quiet window', async () => {
    const pod = await openPod({ debounceMs: 25 });
    const shell = pod.createSandbox();
    const settled = new Promise<{ ok: boolean }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no sync:push within 3s')), 3000);
      pod.events.on('sync:push', (e) => {
        clearTimeout(timer);
        resolve(e);
      });
    });
    await shell.exec('echo auto > /work/auto.txt');
    const event = await settled;
    expect(event.ok).toBe(true);
    const { manifest } = await headManifest(remote, REF);
    expect(manifest.layers.some((l) => l.annotations?.[ANNOTATION_PATH] === '/auto.txt')).toBe(true);
    pod.dispose();
  });

  it('materialize refuses traversal and never follows symlinks', async () => {
    // Hand-rolled malicious head: a path that escapes the folder.
    const evil = await buildFileLayer(
      [{ path: '../../evil.txt', type: 'file', content: new TextEncoder().encode('pwn'), mtimeMs: 0 }],
      { path: '../../evil.txt', mtimeMs: 0, actor: 'mallory' },
    );
    await remote.putBlob(evil.compressed, evil.layerDigest);
    await remote.putBlob(evil.indexBytes, evil.indexDigest);
    const config = new TextEncoder().encode(JSON.stringify({ rootfs: { type: 'layers', diff_ids: [evil.diffId] } }));
    const configDigest = await remote.putBlob(config);
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: config.length },
      layers: [evil.descriptor],
    });
    const manifestDigest = await remote.putBlob(new TextEncoder().encode(manifest));
    await remote.putRef('folder/evil:latest', manifestDigest, 'application/vnd.oci.image.manifest.v1+json');

    const target = await mkdtemp(join(tmpdir(), 'mat-safety-'));
    try {
      const result = await materializeRef(remote, 'folder/evil:latest', target);
      expect(result.skipped).toBe(1);
      expect(result.warnings.some((w) => w.includes('unsafe path refused'))).toBe(true);
      expect(existsSync(join(target, '..', '..', 'evil.txt'))).toBe(false);

      // A symlink squatting on a target is replaced, never written through.
      const victim = join(target, '..', `victim-${Date.now()}`);
      await writeFile(victim, 'safe');
      await symlink(victim, join(target, 'readme.md'));
      await materializeRef(remote, REF, target);
      expect(await nodeReadFile(victim, 'utf8')).toBe('safe');
      expect((await lstat(join(target, 'readme.md'))).isSymbolicLink()).toBe(false);
      expect(await nodeReadFile(join(target, 'readme.md'), 'utf8')).toBe('welcome\n');
      await rm(victim, { force: true });
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});
