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
import { lstat, mkdtemp, mkdir, readdir, readFile as nodeReadFile, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, CopyOnWriteFS, InMemory, resolveMountConfig, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import { clearWhiteoutsOnCreate, type CowInternals } from '../manager/hydration.js';
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
  await resetZen();
});

/** A fresh ZenFS root, as a new process would see it. */
async function resetZen() {
  for (const path of [...zenMounts.keys()]) if (path !== '/') umount(path);
  try {
    umount('/');
  } catch {
    // fresh process
  }
  await configure({ mounts: { '/': InMemory } });
}

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
    // realistic state of an active session). The lower-only parent case is
    // covered separately below.
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

  it('mv into a directory that only exists in the lower lands the file', async () => {
    const pod = await openPod();
    const shell = pod.createSandbox({ confineTo: '/project' });

    // /d has never been written in this session, so it only exists in the
    // lower. ZenFS CoW `rename` alone would silently drop the move.
    await shell.exec('printf two > /src.txt');
    await shell.exec('mv /src.txt /d/moved.txt');
    expect((await shell.exec('cat /d/moved.txt')).stdout).toBe('two');
    expect((await shell.exec('ls /')).stdout).not.toContain('src.txt');

    const push = await pod.pushBasis();
    expect(push?.pushed).toBe(true);

    await materializeRef(remote, REF, dir);
    expect(await nodeReadFile(join(dir, 'd', 'moved.txt'), 'utf8')).toBe('two');
    expect(existsSync(join(dir, 'src.txt'))).toBe(false);
    pod.dispose();
  });

  it.each([false, true])(
    'a rename the writable layer rejects keeps the lower source (no whiteout), target exists: %s',
    async (targetExists) => {
      const lower = await resolveMountConfig({ backend: InMemory });
      const upper = await resolveMountConfig({ backend: InMemory });
      await lower.mkdir('/d', { mode: 0o40755, uid: 0, gid: 0 });
      await lower.createFile('/d/a.txt', { mode: 0o100644, uid: 0, gid: 0 });
      const cow = new CopyOnWriteFS(lower, upper);
      clearWhiteoutsOnCreate(cow as unknown as CowInternals);
      if (targetExists) {
        // An existing upper target makes `exists(to)` true even though nothing moved.
        for (const name of ['b.txt', 'c.txt']) await cow.createFile(`/d/${name}`, { mode: 0o100644, uid: 0, gid: 0 });
      }

      // ZenFS CoW swallows writable-layer rename errors for sources that
      // aren't already deleted; the wrapper must not white out the source.
      const failing = () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }));
      upper.rename = failing;
      upper.renameSync = () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      };

      await expect(cow.rename('/d/a.txt', '/d/b.txt')).rejects.toThrow(/ENOENT/);
      expect(() => cow.renameSync('/d/a.txt', '/d/c.txt')).toThrow(/ENOENT/);
      const entries = (cow as unknown as CowInternals).journal.entries;
      expect(entries.filter((e) => e.op === 'delete')).toEqual([]);
      expect(await cow.exists('/d/a.txt')).toBe(true);
    }
  );

  it('mv of a lower dir after editing one child keeps the untouched children', async () => {
    const pod = await openPod();
    const shell = pod.createSandbox({ confineTo: '/project' });

    // Editing a.txt copies /d into the upper with only that child.
    await shell.exec('printf edited > /d/a.txt');
    await shell.exec('mv /d /e');
    expect((await shell.exec('ls /e')).stdout).toBe('a.txt\nkeep.txt\n');
    expect((await shell.exec('cat /e/keep.txt')).stdout).toBe('keep');
    expect((await shell.exec('ls /')).stdout).not.toContain('d\n');

    const push = await pod.pushBasis();
    expect(push?.pushed).toBe(true);

    await materializeRef(remote, REF, dir);
    expect(await nodeReadFile(join(dir, 'e', 'a.txt'), 'utf8')).toBe('edited');
    expect(await nodeReadFile(join(dir, 'e', 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(dir, 'd', 'a.txt'))).toBe(false);
    expect(existsSync(join(dir, 'd', 'keep.txt'))).toBe(false);
    pod.dispose();
  });

  it('mv a dir over a previously deleted lower dir shows only the moved children', async () => {
    const pod = await openPod();
    const shell = pod.createSandbox({ confineTo: '/project' });

    await shell.exec('rm -rf /d');
    await shell.exec('mkdir /x');
    await shell.exec('printf new > /x/a.txt');
    await shell.exec('mv /x /d');
    // a.txt was whited out by rm -rf; keep.txt is only in the lower.
    expect((await shell.exec('ls /d')).stdout).toBe('a.txt\n');
    expect((await shell.exec('cat /d/a.txt')).stdout).toBe('new');

    const push = await pod.pushBasis();
    expect(push?.pushed).toBe(true);

    await materializeRef(remote, REF, dir);
    expect(await nodeReadFile(join(dir, 'd', 'a.txt'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'd', 'keep.txt'))).toBe(false);
    expect(existsSync(join(dir, 'x'))).toBe(false);
    pod.dispose();
  });

  it('renameSync of a partially copied-up lower dir moves every child', async () => {
    const lower = await resolveMountConfig({ backend: InMemory });
    const upper = await resolveMountConfig({ backend: InMemory });
    const file = { mode: 0o100644, uid: 0, gid: 0 };
    await lower.mkdir('/d', { mode: 0o40755, uid: 0, gid: 0 });
    for (const name of ['a.txt', 'keep.txt']) {
      await lower.createFile(`/d/${name}`, file);
      await lower.write(`/d/${name}`, new TextEncoder().encode(name), 0);
    }
    const cow = new CopyOnWriteFS(lower, upper);
    clearWhiteoutsOnCreate(cow as unknown as CowInternals);

    cow.writeSync('/d/a.txt', new TextEncoder().encode('A'), 0);
    cow.renameSync('/d', '/e');

    expect(cow.readdirSync('/e').sort()).toEqual(['a.txt', 'keep.txt']);
    expect(cow.existsSync('/d')).toBe(false);
    expect(cow.existsSync('/d/keep.txt')).toBe(false);
  });

  it.each(['async', 'sync'] as const)(
    '%s rename refuses lower-only destinations the merged tree must reject',
    async (mode) => {
      const lower = await resolveMountConfig({ backend: InMemory });
      const upper = await resolveMountConfig({ backend: InMemory });
      const dirStats = { mode: 0o40755, uid: 0, gid: 0 };
      const fileStats = { mode: 0o100644, uid: 0, gid: 0 };
      const bytes = (s: string) => new TextEncoder().encode(s);
      await lower.mkdir('/full', dirStats);
      await lower.createFile('/full/kid.txt', fileStats);
      await lower.write('/full/kid.txt', bytes('kid'), 0);
      await lower.createFile('/plain.txt', fileStats);
      await lower.write('/plain.txt', bytes('lower'), 0);
      const cow = new CopyOnWriteFS(lower, upper);
      clearWhiteoutsOnCreate(cow as unknown as CowInternals);
      await cow.createFile('/f.txt', fileStats);
      await cow.write('/f.txt', bytes('upper'), 0);
      await cow.mkdir('/src', dirStats);
      await cow.createFile('/src/s.txt', fileStats);

      const mv = async (a: string, b: string) => (mode === 'async' ? cow.rename(a, b) : cow.renameSync(a, b));
      await expect(mv('/f.txt', '/full')).rejects.toThrow(/EISDIR/);
      await expect(mv('/src', '/full')).rejects.toThrow(/ENOTEMPTY/);
      await expect(mv('/src', '/plain.txt')).rejects.toThrow(/ENOTDIR/);
      await expect(mv('/src', '/src/inner')).rejects.toThrow(/EINVAL/);

      const deletes = () => (cow as unknown as CowInternals).journal.entries.filter((e) => e.op === 'delete');
      expect(deletes()).toEqual([]);
      expect(cow.readdirSync('/full')).toEqual(['kid.txt']);
      expect(cow.existsSync('/f.txt') && cow.existsSync('/src/s.txt')).toBe(true);

      // Replacing a lower-only file is still allowed.
      await mv('/f.txt', '/plain.txt');
      expect(upper.existsSync('/plain.txt')).toBe(true);
      expect(cow.existsSync('/f.txt')).toBe(false);
      // The rename replaces journal.entries, so read it again.
      expect(deletes()).toEqual([]);
    }
  );

  it.each(['async', 'sync'] as const)('%s rename stops when the destination lookup fails', async (mode) => {
    const lower = await resolveMountConfig({ backend: InMemory });
    const upper = await resolveMountConfig({ backend: InMemory });
    const cow = new CopyOnWriteFS(lower, upper);
    clearWhiteoutsOnCreate(cow as unknown as CowInternals);
    await cow.createFile('/a.txt', { mode: 0o100644, uid: 0, gid: 0 });

    const eio = () => Object.assign(new Error('EIO'), { code: 'EIO' });
    const { stat, statSync } = cow;
    cow.stat = (path) => (path === '/b.txt' ? Promise.reject(eio()) : stat.call(cow, path));
    cow.statSync = (path) => {
      if (path === '/b.txt') throw eio();
      return statSync.call(cow, path);
    };

    const mv = async () => (mode === 'async' ? cow.rename('/a.txt', '/b.txt') : cow.renameSync('/a.txt', '/b.txt'));
    await expect(mv()).rejects.toThrow(/EIO/);
    expect(upper.existsSync('/a.txt')).toBe(true);
    expect(upper.existsSync('/b.txt')).toBe(false);
  });

  const dirStats = { mode: 0o40755, uid: 0, gid: 0 };
  const fileStats = { mode: 0o100644, uid: 0, gid: 0 };

  /** Upper-only `/a/x` and an empty upper `/b`. */
  async function upperDirs(lowerSetup?: (lower: Awaited<ReturnType<typeof resolveMountConfig>>) => Promise<void>) {
    const lower = await resolveMountConfig({ backend: InMemory });
    const upper = await resolveMountConfig({ backend: InMemory });
    await lowerSetup?.(lower);
    const cow = new CopyOnWriteFS(lower, upper);
    return { lower, upper, cow };
  }
  async function seedUpper(cow: CopyOnWriteFS) {
    await cow.mkdir('/a', dirStats);
    await cow.createFile('/a/x', fileStats);
    await cow.mkdir('/b', { mode: 0o40700, uid: 7, gid: 7 });
  }
  const deletesOf = (cow: CopyOnWriteFS) =>
    (cow as unknown as CowInternals).journal.entries.filter((e) => e.op === 'delete').map((e) => e.path);

  it.each(['async', 'sync'] as const)('%s rename of a dir onto an empty upper dir replaces it', async (mode) => {
    const { upper, cow } = await upperDirs();
    clearWhiteoutsOnCreate(cow as unknown as CowInternals);
    await seedUpper(cow);
    const moved = upper.statSync('/a/x').ino;

    if (mode === 'async') await cow.rename('/a', '/b');
    else cow.renameSync('/a', '/b');

    expect(cow.readdirSync('/b')).toEqual(['x']);
    expect(upper.statSync('/b/x').ino).toBe(moved);
    expect(cow.existsSync('/a')).toBe(false);
    expect(upper.existsSync('/a')).toBe(false);
    expect(deletesOf(cow)).toEqual([]);
  });

  it.each([
    ['async', 'swallowed'],
    ['async', 'thrown'],
    ['sync', 'swallowed'],
    ['sync', 'thrown'],
  ] as const)('%s rename onto an empty upper dir restores it when the move fails (%s)', async (mode, failure) => {
    const { upper, cow } = await upperDirs();
    const eio = () => Object.assign(new Error('EIO'), { code: 'EIO' });
    if (failure === 'thrown') {
      // The overlay's own rename throws (CoW rethrows for deleted sources).
      cow.rename = () => Promise.reject(eio());
      cow.renameSync = () => {
        throw eio();
      };
    }
    clearWhiteoutsOnCreate(cow as unknown as CowInternals);
    await seedUpper(cow);
    const before = upper.statSync('/b');
    if (failure === 'swallowed') {
      // ZenFS CoW swallows writable-layer rename errors.
      upper.rename = () => Promise.reject(eio());
      upper.renameSync = () => {
        throw eio();
      };
    }

    const mv = async () => (mode === 'async' ? cow.rename('/a', '/b') : cow.renameSync('/a', '/b'));
    await expect(mv()).rejects.toThrow(failure === 'thrown' ? /EIO/ : /ENOENT/);

    const after = upper.statSync('/b');
    expect([after.mode, after.uid, after.gid, after.mtimeMs]).toEqual([before.mode, before.uid, before.gid, before.mtimeMs]);
    expect(cow.readdirSync('/b')).toEqual([]);
    expect(cow.readdirSync('/a')).toEqual(['x']);
    expect(deletesOf(cow)).toEqual([]);
  });

  it.each(['async', 'sync'] as const)(
    '%s rename onto an empty upper dir that also exists in the lower keeps lower children hidden',
    async (mode) => {
      const { cow } = await upperDirs(async (lower) => {
        await lower.mkdir('/b', dirStats);
        await lower.createFile('/b/old.txt', fileStats);
        await lower.mkdir('/c', dirStats);
      });
      clearWhiteoutsOnCreate(cow as unknown as CowInternals);
      // rm -rf /b; mkdir /b — /b is empty in the merged view, /b/old.txt is whited out.
      await cow.unlink('/b/old.txt');
      await cow.rmdir('/b');
      await seedUpper(cow);
      // A lower-only empty dir is a valid target too.
      await cow.mkdir('/e', dirStats);
      await cow.createFile('/e/y', fileStats);

      const mv = async (from: string, to: string) => (mode === 'async' ? cow.rename(from, to) : cow.renameSync(from, to));
      await mv('/a', '/b');
      await mv('/e', '/c');

      expect(cow.readdirSync('/b')).toEqual(['x']);
      expect(cow.existsSync('/b/old.txt')).toBe(false);
      expect(cow.readdirSync('/c')).toEqual(['y']);
      expect(cow.existsSync('/a') || cow.existsSync('/e')).toBe(false);
      expect(deletesOf(cow)).toEqual(['/b/old.txt']);
    }
  );

  it('rename of a dir over a recreated empty lower dir survives the push', async () => {
    const pod = await openPod();
    const shell = pod.createSandbox({ confineTo: '/project' });

    await shell.exec('rm -rf /d');
    await shell.exec('mkdir /d');
    await shell.exec('mkdir /x');
    await shell.exec('printf new > /x/a.txt');
    // `mv /x /d` would move into /d, so rename directly (rename(2) semantics).
    await zfs.promises.rename('/project/x', '/project/d');
    expect((await shell.exec('ls /d')).stdout).toBe('a.txt\n');

    const push = await pod.pushBasis();
    expect(push?.pushed).toBe(true);

    await materializeRef(remote, REF, dir);
    expect(await nodeReadFile(join(dir, 'd', 'a.txt'), 'utf8')).toBe('new');
    expect(existsSync(join(dir, 'd', 'keep.txt'))).toBe(false);
    expect(existsSync(join(dir, 'x'))).toBe(false);
    pod.dispose();
  });

  it.each(['mkdir', 'empty mkdir', 'rename', 'renameSync'] as const)(
    'a directory replacing a deleted lower file survives push and reopen (%s)',
    async (how) => {
      const pod = await openPod();
      const shell = pod.createSandbox({ confineTo: '/project' });

      await shell.exec('rm -f /d/a.txt');
      if (how === 'mkdir' || how === 'empty mkdir') {
        await shell.exec('mkdir /d/a.txt');
        if (how === 'mkdir') await shell.exec('printf new > /d/a.txt/new.txt');
      } else {
        await shell.exec('mkdir /x');
        await shell.exec('printf new > /x/new.txt');
        if (how === 'rename') await zfs.promises.rename('/project/x', '/project/d/a.txt');
        else zfs.renameSync('/project/x', '/project/d/a.txt');
      }
      const children = how === 'empty mkdir' ? '' : 'new.txt\n';
      expect((await shell.exec('ls /d/a.txt')).stdout).toBe(children);

      expect((await pod.pushBasis())?.pushed).toBe(true);
      pod.dispose();

      // A fresh reader: the old file must not shadow the directory.
      const fresh = await mkdtemp(join(tmpdir(), 'replace-'));
      try {
        await materializeRef(remote, REF, fresh);
        expect(await nodeReadFile(join(fresh, 'd', 'keep.txt'), 'utf8')).toBe('keep');
        if (children) expect(await nodeReadFile(join(fresh, 'd', 'a.txt', 'new.txt'), 'utf8')).toBe('new');
      } finally {
        await rm(fresh, { recursive: true, force: true });
      }

      await resetZen();
      const reopened = await openPod();
      const again = reopened.createSandbox({ confineTo: '/project' });
      expect((await again.exec('test -d /d/a.txt && ls /d/a.txt')).stdout).toBe(children);
      expect((await again.exec('ls /d')).stdout).toBe('a.txt\nkeep.txt\n');
      if (children) expect((await again.exec('cat /d/a.txt/new.txt')).stdout).toBe('new');
      reopened.dispose();
    }
  );

  it.each(['empty mkdir', 'mkdir'] as const)(
    'a directory replacing a host file materializes into the original folder (%s)',
    async (how) => {
      const pod = await openPod();
      const shell = pod.createSandbox({ confineTo: '/project' });

      await shell.exec('rm -f /d/a.txt');
      await shell.exec('mkdir /d/a.txt');
      if (how === 'mkdir') await shell.exec('printf new > /d/a.txt/new.txt');
      expect((await pod.pushBasis())?.pushed).toBe(true);
      pod.dispose();

      // The original folder still holds a.txt as a file.
      expect((await lstat(join(dir, 'd', 'a.txt'))).isFile()).toBe(true);
      const result = await materializeRef(remote, REF, dir);
      expect(result.warnings).toEqual([]);
      expect((await lstat(join(dir, 'd', 'a.txt'))).isDirectory()).toBe(true);
      const children = how === 'mkdir' ? ['new.txt'] : [];
      expect(await readdir(join(dir, 'd', 'a.txt'))).toEqual(children);
      if (how === 'mkdir') expect(await nodeReadFile(join(dir, 'd', 'a.txt', 'new.txt'), 'utf8')).toBe('new');
      expect(await nodeReadFile(join(dir, 'd', 'keep.txt'), 'utf8')).toBe('keep');
    }
  );

  it.each(['mkdir', 'rename'] as const)(
    'an empty directory re-created after its deletion was pushed survives the next push (%s)',
    async (how) => {
      const pod = await openPod();
      const shell = pod.createSandbox({ confineTo: '/project' });

      await shell.exec('rm -f /d/a.txt');
      expect((await pod.pushBasis())?.pushed).toBe(true);

      if (how === 'mkdir') await shell.exec('mkdir /d/a.txt');
      else {
        await shell.exec('mkdir /x');
        await zfs.promises.rename('/project/x', '/project/d/a.txt');
      }
      expect((await pod.pushBasis())?.pushed).toBe(true);
      pod.dispose();

      await materializeRef(remote, REF, dir);
      expect(await readdir(join(dir, 'd', 'a.txt'))).toEqual([]);

      await resetZen();
      const reopened = await openPod();
      const again = reopened.createSandbox({ confineTo: '/project' });
      expect((await again.exec('test -d /d/a.txt && ls /d/a.txt')).exitCode).toBe(0);
      expect((await again.exec('ls /d')).stdout).toBe('a.txt\nkeep.txt\n');
      reopened.dispose();
    }
  );

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
