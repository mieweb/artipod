import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ZenFsLike } from '../sandbox/types.js';
import { createStorageSession, type StorageSession } from '../storage/index.js';
import { SnapshotManager } from './snapshot.js';
import { OciStore } from './store.js';

const sessions: StorageSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); });

async function fixture() {
  const session = createStorageSession({ policy: 'memory' });
  sessions.push(session);
  const storage = await session.open();
  return { session, storage, zfs: storage.zfs };
}

describe('protected snapshot output ownership', () => {
  it('rejects an unrelated plaintext store before capture or output I/O', async () => {
    const { zfs, storage } = await fixture();
    const readFile = vi.fn();
    const writeFile = vi.fn();
    const mkdir = vi.fn();
    const plain = { promises: { readFile, writeFile, mkdir } } as unknown as ZenFsLike;
    const store = new OciStore(plain);
    const putUncompressed = vi.spyOn(store, 'putUncompressed');
    const putLayerIndex = vi.spyOn(store, 'putLayerIndex');
    expect(() => new SnapshotManager({ zfs, storage, store, roots: ['/repo'] })).toThrow('same live core storage context');
    expect(readFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(putUncompressed).not.toHaveBeenCalled();
    expect(putLayerIndex).not.toHaveBeenCalled();
  });

  it('rejects store lookalikes and inherited bindings instead of trusting public metadata', async () => {
    const { zfs, storage } = await fixture();
    const store = new OciStore(zfs, { storage });
    for (const forged of [Object.create(store), Object.create(OciStore.prototype, { zfs: { value: zfs }, storage: { value: storage }, encrypted: { value: true } })]) {
      expect(() => new SnapshotManager({ zfs, storage, store: forged, roots: ['/repo'] })).toThrow('same live core storage context');
    }
  });

  it('keeps same-context stores usable with inferred ownership and revokes them on close', async () => {
    const { session, storage, zfs } = await fixture();
    const store = new OciStore(zfs);
    await store.init();
    await zfs.promises.writeFile('/repo/PRIVATE-patient.csv', 'PRIVATE-row\n');
    const snapshots = new SnapshotManager({ zfs, store, roots: ['/repo'] });
    const snapshot = (await snapshots.create())!;
    expect((await store.getLayerIndex(snapshot.diff.diffId)).entries.map(entry => entry.path)).toContain('/repo/PRIVATE-patient.csv');
    await snapshots.commit('saved:1');
    expect(await store.getRef('saved:1')).not.toBeNull();
    await session.close();
    await expect(snapshots.create()).rejects.toThrow('core storage context');
    expect(() => new SnapshotManager({ zfs, storage, store, roots: ['/repo'] })).toThrow('core storage context');
  });
});
