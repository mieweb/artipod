import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZenFsLike } from '../sandbox/types.js';
import { createStorageSession, type StorageSession } from '../storage/index.js';
import { AuditLog } from '../manager/audit.js';
import { generateBlobKey } from './cipher.js';
import { readPodSettings, SETTINGS_PATH, writePodSettings } from './settings.js';
import { SnapshotManager } from './snapshot.js';
import { OciStore } from './store.js';
import { ANNOTATION_LAYER_INDEX } from './tar.js';
import { ANNOTATION_PARENTS } from './file-layer.js';
import type { ImageManifest } from './pull.js';
import type { Digest } from './digest.js';

const sessions: StorageSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); });
async function fixture() {
  const session = createStorageSession({ policy: 'memory' });
  sessions.push(session);
  const storage = await session.open();
  const zfs = storage.zfs;
  const store = new OciStore(zfs, { storage });
  await store.init();
  const snapshots = new SnapshotManager({ zfs, storage, store, roots: ['/repo'] });
  return { zfs, store, snapshots };
}
const bytes = (text: string) => new TextEncoder().encode(text);
const blobPath = (digest: Digest) => `/.artipod/oci/blobs/sha256/${digest.slice(7)}`;

describe('private settings and snapshot metadata', () => {
  it.each(['EACCES', 'EIO'])('propagates %s instead of treating inaccessible offline preferences as false', async code => {
    const failure = Object.assign(new Error('settings unavailable'), { code });
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const zfs = { promises: { mkdir, writeFile, readFile: vi.fn(async () => { throw failure; }) } } as unknown as ZenFsLike;
    await expect(readPodSettings(zfs)).rejects.toBe(failure);
    await expect(writePodSettings(zfs, { offline: false })).rejects.toBe(failure);
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each(['{broken', 'null', '[]', '{"offline":"false"}'])('preserves malformed saved settings: %s', async text => {
    const { zfs } = await fixture();
    await zfs.promises.writeFile(SETTINGS_PATH, text);
    await expect(readPodSettings(zfs)).rejects.toThrow();
    await expect(writePodSettings(zfs, { offline: false })).rejects.toThrow();
    expect(await zfs.promises.readFile(SETTINGS_PATH, 'utf8')).toBe(text);
  });

  it('does not ignore a directory failure before writing new settings', async () => {
    const failure = new Error('directory creation failed');
    const writeFile = vi.fn();
    const zfs = { promises: {
      readFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      mkdir: async () => { throw failure; }, writeFile,
    } } as unknown as ZenFsLike;
    await expect(writePodSettings(zfs, { offline: true })).rejects.toBe(failure);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('rejects corrupt HEAD without replacing the checkpoint parent or writing a new snapshot', async () => {
    const { zfs, snapshots } = await fixture();
    await snapshots.create();
    const path = '/.artipod/oci/snapshots/HEAD';
    await zfs.promises.writeFile(path, 'corrupt-head');
    const before = await zfs.promises.readdir('/.artipod/oci/snapshots');
    await expect(snapshots.create()).rejects.toThrow('checkpoint ID');
    expect(await zfs.promises.readdir('/.artipod/oci/snapshots')).toEqual(before);
    expect(await zfs.promises.readFile(path, 'utf8')).toBe('corrupt-head');
  });

  it.each(['snapshot', 'ref', 'manifest', 'config', 'parents'])('aborts gc before any deletion when reachable %s metadata is corrupt', async kind => {
    const { zfs, store, snapshots } = await fixture();
    const snapshot = (await snapshots.create())!;
    await snapshots.commit('saved:1');
    const ref = (await store.getRef('saved:1'))!;
    const manifest = JSON.parse(new TextDecoder().decode(await store.getBlob(ref.manifestDigest))) as ImageManifest;
    const unreachable = await store.putBlob(bytes('unreachable but must survive failed collection'));
    if (kind === 'snapshot') await zfs.promises.writeFile(`/.artipod/oci/snapshots/${snapshot.id}.json`, '{corrupt');
    else if (kind === 'ref') await zfs.promises.writeFile('/.artipod/oci/refs/saved%3A1.json', '{corrupt');
    else if (kind === 'manifest') await zfs.promises.writeFile(blobPath(ref.manifestDigest), '{corrupt');
    else if (kind === 'config') await zfs.promises.writeFile(blobPath(manifest.config.digest), '{corrupt');
    else {
      manifest.annotations = { [ANNOTATION_PARENTS]: 'invalid-json' };
      const digest = await store.putBlob(bytes(JSON.stringify(manifest)));
      await store.putRef('saved:1', digest, 'application/vnd.oci.image.manifest.v1+json');
    }
    const before = await zfs.promises.readdir('/.artipod/oci/blobs/sha256');
    await expect(snapshots.gc()).rejects.toThrow();
    expect(await zfs.promises.readdir('/.artipod/oci/blobs/sha256')).toEqual(before);
    expect(await store.getBlob(unreachable)).toEqual(bytes('unreachable but must survive failed collection'));
  });

  it('retains encrypted aliases, layer-index artifacts and parent manifests reachable from refs', async () => {
    const { zfs, store, snapshots } = await fixture();
    await store.enableEncryption(await generateBlobKey());
    await zfs.promises.writeFile('/repo/saved.txt', 'saved content');
    await snapshots.commit('ancestor:1');
    const ancestor = (await store.getRef('ancestor:1'))!.manifestDigest;
    const manifest = JSON.parse(new TextDecoder().decode(await store.getBlob(ancestor))) as ImageManifest;
    manifest.annotations = { [ANNOTATION_PARENTS]: JSON.stringify([ancestor]) };
    const current = await store.putBlob(bytes(JSON.stringify(manifest)));
    await store.putRef('current:1', current, 'application/vnd.oci.image.manifest.v1+json');
    await store.deleteRef('ancestor:1');
    await store.putBlob(bytes('collectible encrypted bytes'));
    expect((await snapshots.gc()).deleted).toBeGreaterThan(0);
    expect(await store.getBlob(current)).toEqual(bytes(JSON.stringify(manifest)));
    expect(await store.getBlob(ancestor)).toBeInstanceOf(Uint8Array);
    expect(await store.getBlob(manifest.config.digest)).toBeInstanceOf(Uint8Array);
    for (const layer of manifest.layers) {
      expect(await store.getBlob(layer.digest)).toBeInstanceOf(Uint8Array);
      expect(await store.getBlob(layer.annotations![ANNOTATION_LAYER_INDEX] as Digest)).toBeInstanceOf(Uint8Array);
    }
  });

  it('retains the entire audit chain rather than only the head record during gc', async () => {
    const { store, snapshots } = await fixture();
    const audit = new AuditLog(store);
    await audit.append({ at: new Date().toISOString(), kind: 'login', principal: 'user' });
    await audit.append({ at: new Date().toISOString(), kind: 'lock', principal: 'user' });
    await store.putBlob(bytes('collectible bytes'));
    expect((await snapshots.gc()).deleted).toBeGreaterThan(0);
    expect((await audit.read()).map(event => event.kind)).toEqual(['login', 'lock']);
  });
});
