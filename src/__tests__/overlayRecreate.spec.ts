/**
 * Regression — recreate-over-delete data loss (overlay write-back).
 *
 * Deleting a file that lives in the LOWER (a pushed basis layer) records a
 * deletion in the ZenFS CopyOnWrite journal. That journal's `delete` log is
 * append-only: recreating the same path in the upper never clears the entry,
 * so `journal.isDeleted(path)` keeps reporting the path as gone. The overlay
 * push then emitted a whiteout for a path the upper had just rewritten, and
 * the whiteout (last layer) won the OCI merge — the file was silently dropped
 * on push (and a fresh reader got ENOENT). See
 * `Hydrator.overlayDeletions` in src/manager/hydration.ts.
 *
 * All write paths that recreate a whited-out lower path must survive the
 * push and show up in the pod's own directory listing: bash create, a direct
 * pod-fs writeFile, `mv` over the deleted path, and `rm -rf <dir>` followed by
 * `mkdir`+write inside it. `mv` of a lower file must also remove the source.
 */
import { mkdtemp, mkdir, readFile as nodeReadFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import { sha256, type Digest } from '../oci/digest.js';
import type { StoredRef } from '../oci/store.js';
import type { ImageManifest } from '../oci/pull.js';
import { ANNOTATION_PATH } from '../oci/file-layer.js';
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
async function headLayers(store: PodStore, ref: string): Promise<(string | undefined)[]> {
  const head = (await store.getRef(ref))!;
  const manifest = JSON.parse(decoder.decode(await store.getBlob(head.manifestDigest))) as ImageManifest;
  return manifest.layers.map((l) => l.annotations?.[ANNOTATION_PATH]);
}

const podManifest: PodManifest = {
  formatVersion: 1,
  mounts: [{ name: 'root', path: '/', mode: 'rw', source: { kind: 'backend', backend: 'memory' } }],
};

const REF = 'folder/demo:latest';
let dir: string;
let remote: PodStore;

beforeEach(async () => {
  // Lower (pushed basis): /d/a.txt = "one" plus a sibling so /d is non-empty
  // even after a.txt is removed.
  dir = await mkdtemp(join(tmpdir(), 'recreate-'));
  await mkdir(join(dir, 'd'), { recursive: true });
  await writeFile(join(dir, 'd', 'a.txt'), 'one');
  await writeFile(join(dir, 'd', 'keep.txt'), 'keep');
  const t = new Date('2026-08-30T12:00:00Z');
  for (const f of ['d/a.txt', 'd/keep.txt']) await utimes(join(dir, f), t, t);
  remote = memStore();
  await publishDirectory(remote, dir, REF, { actor: 'server:test' });

  for (const path of [...zenMounts.keys()]) if (path !== '/') umount(path);
  try {
    umount('/');
  } catch {
    // fresh process
  }
  await configure({ mounts: { '/': InMemory } });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const openPod = () =>
  createZenFsPod(podManifest, {
    adopt: zfs,
    sync: { remote, basis: { ref: REF, at: '/project' }, actor: 'browser:test', autoPush: false },
    hydration: { policy: { default: 'lazy' }, onDemand: 'fetch' },
  });

describe('overlay recreate-over-delete (data-loss regression)', () => {
  it('bash: rm then recreate a lower file keeps the new content (no whiteout wins)', async () => {
    const pod = await openPod();
    const shell = pod.createSandbox({ confineTo: '/project' });

    await shell.exec('rm -f /d/a.txt');
    await shell.exec('printf two > /d/a.txt');

    // The directory listing and the file lookup must agree inside the pod too.
    expect((await shell.exec('cat /d/a.txt')).stdout).toBe('two');
    expect((await shell.exec('ls /d')).stdout).toBe('a.txt\nkeep.txt\n');

    const push = await pod.pushBasis();
    expect(push?.pushed).toBe(true);

    // No whiteout layer for a.txt — only the rewritten file layer.
    const layers = await headLayers(remote, REF);
    expect(layers).toContain('/d/a.txt');
    expect(layers).not.toContain('.wh');

    await materializeRef(remote, REF, dir);
    expect(await nodeReadFile(join(dir, 'd', 'a.txt'), 'utf8')).toBe('two');
    expect(await nodeReadFile(join(dir, 'd', 'keep.txt'), 'utf8')).toBe('keep');
    pod.dispose();
  });

  it('direct pod fs writeFile over a deleted lower path survives the push', async () => {
    const pod = await openPod();
    const p = zfs.promises;

    await p.unlink('/project/d/a.txt');
    await p.writeFile('/project/d/a.txt', 'two');

    const push = await pod.pushBasis();
    expect(push?.pushed).toBe(true);
    expect(await headLayers(remote, REF)).not.toContain('.wh');

    await materializeRef(remote, REF, dir);
    expect(await nodeReadFile(join(dir, 'd', 'a.txt'), 'utf8')).toBe('two');
    pod.dispose();
  });

  it('mv over a deleted lower path survives the push (recreate lands in the upper)', async () => {
    const pod = await openPod();
    const shell = pod.createSandbox({ confineTo: '/project' });

    // Touch a sibling first so /d is materialized in the writable upper (the
    // realistic state of an active session). ZenFS CoW `rename` does not
    // create parent directories in the writable, so without this the rename
    // target's content would never land — a SEPARATE upstream bug, orthogonal
    // to the whiteout-wins data loss under test here.
    await shell.exec('printf sib > /d/sib.txt');
    await shell.exec('rm -f /d/a.txt');
    await shell.exec('printf two > /src.txt');
    await shell.exec('mv /src.txt /d/a.txt');
    expect((await shell.exec('cat /d/a.txt')).stdout).toBe('two');

    const push = await pod.pushBasis();
    expect(push?.pushed).toBe(true);
    expect(await headLayers(remote, REF)).not.toContain('.wh');

    await materializeRef(remote, REF, dir);
    expect(await nodeReadFile(join(dir, 'd', 'a.txt'), 'utf8')).toBe('two');
    pod.dispose();
  });

  it('rm -rf a lower dir then mkdir + write inside it survives the push', async () => {
    const pod = await openPod();
    const shell = pod.createSandbox({ confineTo: '/project' });

    await shell.exec('rm -rf /d');
    await shell.exec('mkdir /d');
    await shell.exec('printf two > /d/a.txt');
    expect((await shell.exec('cat /d/a.txt')).stdout).toBe('two');

    const push = await pod.pushBasis();
    expect(push?.pushed).toBe(true);

    await materializeRef(remote, REF, dir);
    expect(await nodeReadFile(join(dir, 'd', 'a.txt'), 'utf8')).toBe('two');
    // keep.txt was genuinely removed (rm -rf) and never recreated.
    expect(existsSync(join(dir, 'd', 'keep.txt'))).toBe(false);
    pod.dispose();
  });

  it('mv of a lower file removes it from its old path', async () => {
    const pod = await openPod();
    const shell = pod.createSandbox({ confineTo: '/project' });

    await shell.exec('mv /d/a.txt /d/b.txt');
    expect((await shell.exec('ls /d')).stdout).toBe('b.txt\nkeep.txt\n');

    const push = await pod.pushBasis();
    expect(push?.pushed).toBe(true);

    await materializeRef(remote, REF, dir);
    expect(existsSync(join(dir, 'd', 'a.txt'))).toBe(false);
    expect(await nodeReadFile(join(dir, 'd', 'b.txt'), 'utf8')).toBe('one');
    pod.dispose();
  });

  it('a genuine delete (not recreated) still whites the file out', async () => {
    const pod = await openPod();
    const shell = pod.createSandbox({ confineTo: '/project' });

    await shell.exec('rm -f /d/a.txt');
    const push = await pod.pushBasis();
    expect(push?.pushed).toBe(true);

    await materializeRef(remote, REF, dir);
    expect(existsSync(join(dir, 'd', 'a.txt'))).toBe(false);
    expect(await nodeReadFile(join(dir, 'd', 'keep.txt'), 'utf8')).toBe('keep');
    pod.dispose();
  });
});
