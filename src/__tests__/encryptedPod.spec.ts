/**
 * Phase 6.5 end-to-end: encryption ON through the pod surface — the
 * "ciphertext at rest, keys on a lease" plan item (docs/encryption.md).
 * Locked pods refuse work with EACCES + hint; login → edit → commit →
 * encrypted push (relay sees only ciphertext) → lock → restore → second
 * device pulls and reads. Plaintext exists only in memory throughout.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts, bindContext } from '@zenfs/core';
import type { PodFs } from '../types.js';
import type { ZenFsLike } from '../sandbox/types.js';
import { createZenFsPod, type ZenFsPod } from '../realize/zenfs.js';
import { Authority } from '../manager/authority.js';
import { OciLayoutPodStore } from '../manager/pod-store.js';
import { isEncryptedBlob } from '../oci/cipher.js';
import type { PodManifest } from '../manifest.js';

const manifest = (name: string): PodManifest => ({
  formatVersion: 1,
  name,
  mounts: [{ name: 'root', path: '/', mode: 'rw', source: { kind: 'backend', backend: 'memory' } }],
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

describe('encrypted pod, end to end', () => {
  beforeEach(async () => {
    unmountAll();
    await configure({ mounts: { '/': InMemory } });
  });

  it('login → edit → commit → encrypted push → lock (EACCES) → restore → second device pulls', async () => {
    const authority = await Authority.create('home-base');

    // The deployment's manager store — sees ciphertext only.
    await zfs.promises.mkdir('/manager-store', { recursive: true });
    const remote = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/manager-store');
    await remote.init();

    // --- device A ------------------------------------------------------
    await zfs.promises.mkdir('/repo', { recursive: true });
    let podA: ZenFsPod | null = null;
    podA = await createZenFsPod(manifest('device-a'), {
      adopt: zfs,
      cwd: '/repo',
      sync: { remote },
      authority: {
        encrypt: true,
        login: async () =>
          authority.login({
            principal: 'user:alice',
            podIds: [podA!.oci.store.getSuperblock().podId],
            ttlMs: 60 * 60_000,
          }),
      },
    });
    authority.registerPod(podA.oci.store.getSuperblock().podId);
    const shellA = podA.createSandbox();

    // Locked pod: store-backed work refuses with EACCES + the login hint.
    // (Content first — an empty diff writes no blobs and proves nothing.)
    await shellA.exec('echo "cliff notes: patient stable, bp 120/80" > visit.md');
    const beforeLogin = await shellA.exec('artipod snapshot create');
    expect(beforeLogin.exitCode).not.toBe(0);
    expect(beforeLogin.stderr).toContain('EACCES');
    expect(beforeLogin.stderr).toContain('artipod login');
    expect((await shellA.exec('artipod status')).stdout).toContain('locked');

    // Login populates the keyring on a lease; work proceeds.
    const login = await shellA.exec('artipod login');
    expect(login.exitCode).toBe(0);
    expect(login.stdout).toContain('user:alice');
    expect((await shellA.exec('cat /proc/keys/keys')).stdout).toContain('kek:');

    const commit = await shellA.exec('artipod commit --tag field/notes:1');
    expect(commit.exitCode).toBe(0);

    // Encrypted push: the manager receives ciphertext, never a key.
    const push = await shellA.exec('artipod push field/notes:1');
    expect(push.exitCode).toBe(0);
    expect(push.stdout).toContain('(encrypted)');
    const managerBlobs = (await zfs.promises.readdir('/manager-store/blobs/sha256')) as string[];
    expect(managerBlobs.length).toBeGreaterThanOrEqual(4); // 3 blobs + sealed envelope
    for (const name of managerBlobs) {
      const raw = (await zfs.promises.readFile(`/manager-store/blobs/sha256/${name}`)) as Uint8Array;
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      expect(isEncryptedBlob(bytes)).toBe(true);
      expect(new TextDecoder().decode(bytes)).not.toContain('patient stable');
    }

    // Lock drops the key; the data was not touched.
    expect((await shellA.exec('artipod lock')).exitCode).toBe(0);
    const lockedCommit = await shellA.exec('artipod commit --tag field/notes:2');
    expect(lockedCommit.exitCode).not.toBe(0);
    expect(lockedCommit.stderr).toContain('EACCES');
    expect((await shellA.exec('artipod status')).stdout).toContain('locked');

    // Login restores instantly — no rewrite, same store.
    expect((await shellA.exec('artipod login')).exitCode).toBe(0);
    expect((await shellA.exec('artipod commit --tag field/notes:2')).exitCode).toBe(0);

    // --- device B: fresh chroot, same authority ------------------------
    await zfs.promises.mkdir('/device-b/repo', { recursive: true });
    const ctxB = bindContext({ root: '/device-b' });
    const zfsB = ctxB.fs as unknown as ZenFsLike;
    let podB: ZenFsPod | null = null;
    podB = await createZenFsPod(manifest('device-b'), {
      adopt: zfsB,
      cwd: '/repo',
      sync: { remote },
      authority: {
        encrypt: true,
        login: async () => {
          // Same pod family: the authority leases pod A's KEK to device B
          // under B's pod id binding (shared-KEK volume, docs/encryption.md
          // rewrap-not-reencrypt: one KEK, many holders).
          const result = await authority.login({
            principal: 'user:alice',
            podIds: [podA!.oci.store.getSuperblock().podId],
            ttlMs: 60 * 60_000,
          });
          return {
            lease: result.lease,
            keys: { [podB!.oci.store.getSuperblock().podId]: result.keys[podA!.oci.store.getSuperblock().podId] },
          };
        },
      },
    });
    const shellB = podB.createSandbox();
    expect((await shellB.exec('artipod login')).exitCode).toBe(0);

    const pull = await shellB.exec('artipod pull field/notes:1');
    expect(pull.exitCode).toBe(0);
    expect(pull.stdout).toContain('(encrypted)');

    // Pulling without a key is refused outright.
    const clone = await shellB.exec('artipod clone field/notes:1 /clones/notes');
    expect(clone.exitCode).toBe(0);
    // Device A's workspace root was '/', so the layer carries /repo/visit.md.
    const read = await shellB.exec('cat /clones/notes/repo/visit.md');
    expect(read.stdout).toContain('patient stable, bp 120/80');

    podA.dispose();
    podB.dispose();
  });
});
