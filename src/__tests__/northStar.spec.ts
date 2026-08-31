/**
 * THE NORTH-STAR DEMO (plan Phase 6 done-when, the examples/web-demo
 * replacement) — scripted end to end:
 *
 *   1. browser pod edits offline → artipod snapshot create
 *   2. artipod clone into a second local tree
 *   3. reconnect → push: the server manager (OCI image-layout store on a
 *      real directory) pulls with only missing digests moving
 *   4. the server runs a containerized job (docker realizer) over the same
 *      content and commits a derived layer
 *   5. the browser pulls the derived ref and mounts it read-only next to
 *      the workspace
 *   6. artipod compact squashes the browser pod's history
 *
 * "Browser" = a ZenFS InMemory pod (the same code path the app runs);
 * "server" = an OciLayoutPodStore over a real tempdir + ArtiPod.fromManifest
 * docker execution. Requires docker (this suite lives in __tests__).
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import { createZenFsPod, type ZenFsPod } from '../realize/zenfs.js';
import { ArtiPod } from '../artipod.js';
import { nodePodFs } from '../nodePodFs.js';
import { OciLayoutPodStore } from '../manager/pod-store.js';
import { syncRef, storeTransport } from '../manager/sync.js';
import { SnapshotManager } from '../oci/snapshot.js';
import { OciStore } from '../oci/store.js';
import { pullImage } from '../oci/pull.js';
import type { Sandbox } from '../sandbox/types.js';

let browserPod: ZenFsPod;
let shell: Sandbox;
let serverDir: string;
let serverStore: OciLayoutPodStore;
let serverWorkDir: string;

const dockerfilePath = join(process.cwd(), 'container', 'Dockerfile');
const seccompProfilePath = join(process.cwd(), 'container', 'seccomp-profiles', 'sandbox.json');

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

beforeAll(async () => {
  unmountAll();
  await configure({ mounts: { '/': InMemory } });
  await zfs.promises.mkdir('/repo');
  serverDir = await mkdtemp(join(tmpdir(), 'artipod-manager-'));
  serverStore = new OciLayoutPodStore(nodePodFs(), serverDir);
  await serverStore.init();

  browserPod = await createZenFsPod(
    { mounts: [{ name: 'root', path: '/', source: { kind: 'backend', backend: 'memory' }, mode: 'rw' }] },
    { adopt: zfs, cwd: '/repo', proc: false, sync: { remote: serverStore } },
  );
  shell = browserPod.createSandbox();
}, 30000);

afterAll(async () => {
  await rm(serverDir, { recursive: true, force: true });
  if (serverWorkDir) await rm(serverWorkDir, { recursive: true, force: true });
}, 30000);

describe('north-star demo', () => {
  it('1. browser edits offline and snapshots', async () => {
    await shell.exec('echo "field notes v1" > /repo/notes.txt && mkdir -p /repo/data && echo 42 > /repo/data/reading.txt');
    const snap = await shell.exec('artipod snapshot create offline-work');
    expect(snap.exitCode).toBe(0);
    expect((await shell.exec('artipod snapshot ls')).stdout).toContain('offline-work');
  });

  it('2. commit + clone into a second local tree', async () => {
    expect((await shell.exec('artipod commit --tag field/notes:1')).exitCode).toBe(0);
    const clone = await shell.exec('artipod clone field/notes:1 /clones/notes');
    expect(clone.exitCode).toBe(0);
    expect((await shell.exec('cat /clones/notes/repo/notes.txt')).stdout).toBe('field notes v1\n');
    // the clone is writable and independent
    await shell.exec('echo divergent >> /clones/notes/repo/notes.txt');
    expect((await shell.exec('cat /repo/notes.txt')).stdout).toBe('field notes v1\n');
  });

  it('3. reconnect → push; only missing digests move (and a re-push moves zero)', async () => {
    const push = await shell.exec('artipod push field/notes:1');
    expect(push.exitCode).toBe(0);
    expect(push.stdout).toMatch(/pushed field\/notes:1: 3 blobs moved/); // manifest + config + layer

    const again = await shell.exec('artipod push field/notes:1');
    expect(again.stdout).toMatch(/0 blobs moved .*3 already there/);

    // the manager's store is a real skopeo-shaped layout on disk
    const layout = JSON.parse(await readFile(join(serverDir, 'index.json'), 'utf8'));
    expect(layout.manifests[0].annotations['org.opencontainers.image.ref.name']).toBe('field/notes:1');
  });

  it('4. server pulls, runs a containerized job over the content, commits a derived layer', async () => {
    serverWorkDir = await mkdtemp(join(tmpdir(), 'artipod-server-work-'));
    const { chmod } = await import('node:fs/promises');
    await chmod(serverWorkDir, 0o777);

    // pull ref into a scratch zenfs store area, then materialize onto the real dir via nodePodFs
    const scratch = new OciStore(zfs);
    await scratch.init();
    await pullImage({ store: scratch, transport: storeTransport(serverStore), ref: 'field/notes:1' });
    await scratch.putRef('field/notes:1', (await serverStore.getRef('field/notes:1'))!.manifestDigest, 'application/vnd.oci.image.manifest.v1+json');

    // materialize into the host dir the docker realizer will bind
    const hostFs = nodePodFs();
    const { loadImageLayers } = await import('../oci/pull.js');
    const { mergeLayerEntries } = await import('../oci/view.js');
    const { layers, layerBytes } = await loadImageLayers(scratch, (await scratch.getRef('field/notes:1'))!.manifestDigest);
    const merged = mergeLayerEntries(layers);
    for (const [path, entry] of [...merged.entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const dest = `${serverWorkDir}${path}`;
      if (entry.type === 'dir') await hostFs.mkdir(dest, { recursive: true });
      else if (entry.type === 'file') {
        await hostFs.mkdir(dest.slice(0, dest.lastIndexOf('/')), { recursive: true });
        await hostFs.writeFile(dest, layerBytes[entry.layer].subarray(entry.offset, entry.offset + entry.size));
      }
    }
    await chmod(join(serverWorkDir, 'repo'), 0o777);

    // heavy execution: the docker backend over the same content
    const pod = ArtiPod.fromManifest({
      mounts: [{ name: 'work', path: '/work', source: { kind: 'hostDir', dir: serverWorkDir }, mode: 'rw' }],
    });
    await pod.initialize();
    await pod.startContainer(dockerfilePath, { seccompProfilePath });
    const job = await pod.executeCommand('sh -c "wc -w < /work/repo/notes.txt > /work/repo/derived.txt && cat /work/repo/derived.txt"');
    await pod.stopContainer();
    expect(job.exitCode).toBe(0);
    expect(job.stdout.trim()).toBe('3'); // "field notes v1"

    // server commits the derived workspace back into ITS manager store
    const serverSnapshots = new SnapshotManager({ zfs, store: scratch, roots: ['/server-derived'] });
    await zfs.promises.mkdir('/server-derived/repo', { recursive: true });
    for (const name of ['notes.txt', 'derived.txt']) {
      const bytes = await readFile(join(serverWorkDir, 'repo', name));
      await zfs.promises.writeFile(`/server-derived/repo/${name}`, new Uint8Array(bytes));
    }
    await serverSnapshots.commit('field/notes:derived');
    const synced = await syncRef(scratch, serverStore, 'field/notes:derived');
    expect(synced.moved).toBeGreaterThan(0);
  }, 180000);

  it('5. browser pulls the derived layer and mounts it read-only beside the workspace', async () => {
    const pull = await shell.exec('artipod pull field/notes:derived');
    expect(pull.exitCode).toBe(0);
    const mountR = await shell.exec('artipod image mount field/notes:derived /mnt/derived');
    expect(mountR.exitCode).toBe(0);
    expect((await shell.exec('cat /mnt/derived/server-derived/repo/derived.txt')).stdout.trim()).toBe('3');
    // read-only beside the (unchanged) live workspace
    expect((await shell.exec('sh -c "echo x > /mnt/derived/server-derived/repo/nope"')).exitCode).not.toBe(0);
    expect((await shell.exec('cat /repo/notes.txt')).stdout).toBe('field notes v1\n');
  });

  it('6. artipod compact squashes the browser pod history', async () => {
    await shell.exec('echo more >> /repo/notes.txt');
    await shell.exec('artipod snapshot create later-work');
    const before = await browserPod.snapshots.list();
    expect(before.length).toBeGreaterThan(1);
    const compact = await shell.exec('artipod compact');
    expect(compact.exitCode).toBe(0);
    const after = await browserPod.snapshots.list();
    expect(after).toHaveLength(1);
    expect(after[0].origin).toBe('compact');
  });
});
