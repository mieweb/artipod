import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore, StoreFS } from '@zenfs/core';
import { configureStorageRoot, createMemoryStorageRoot } from '../sandbox/storage.js';
import { createStorageSession, type StorageSession } from '../storage/session.js';
import { OciStore } from '../oci/store.js';
import { createZenFsPod, realizeZenFs, type ZenFsPod } from './zenfs.js';

const backend = vi.hoisted(() => ({ create: undefined as (() => Promise<StoreFS>) | undefined }));
vi.mock('@zenfs/dom', () => ({
  IndexedDB: { name: 'DelayedRawStore', options: { storeName: { type: 'string', required: false } }, create: () => backend.create!() },
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

const sessions: StorageSession[] = [];
const pods: ZenFsPod[] = [];
const releases: Array<() => void> = [];
afterEach(async () => {
  releases.splice(0).forEach(release => release());
  pods.splice(0).forEach(pod => pod.dispose());
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
  vi.restoreAllMocks();
});

const manifest = { mounts: [{ name: 'root', path: '/', mode: 'rw' as const, source: { kind: 'backend' as const, backend: 'indexeddb' as const } }] };

describe('raw manifest operation ownership', () => {
  it.each(['realize', 'pod'] as const)('keeps managed roots out while %s awaits raw backend creation', async operation => {
    await configureStorageRoot(await createMemoryStorageRoot());
    const entered = deferred();
    const resume = deferred();
    releases.push(resume.resolve);
    const store = new InMemoryStore();
    backend.create = async () => {
      entered.resolve();
      await resume.promise;
      const root = new StoreFS(store);
      root.checkRootSync();
      return root;
    };
    const opening = operation === 'realize'
      ? realizeZenFs(manifest, { storagePolicy: 'plaintext' })
      : createZenFsPod(manifest, { storagePolicy: 'plaintext', proc: false }).then(pod => { pods.push(pod); return pod; });
    await entered.promise;
    const session = createStorageSession({ policy: 'memory' });
    sessions.push(session);
    await expect(session.open()).rejects.toThrow('raw storage operation is in progress');
    resume.resolve();
    await opening;
    const protectedRoot = await session.open();
    await protectedRoot.zfs.promises.writeFile('/repo/PRIVATE-patient.csv', 'PRIVATE-medical-record');
    for (const bytes of store.values()) expect(new TextDecoder().decode(bytes)).not.toContain('PRIVATE');
  });

  it('holds raw pod ownership through awaited OCI initialization after mounts are ready', async () => {
    await configureStorageRoot(await createMemoryStorageRoot());
    const entered = deferred();
    const resume = deferred();
    releases.push(resume.resolve);
    const original = OciStore.prototype.init;
    vi.spyOn(OciStore.prototype, 'init').mockImplementation(async function (this: OciStore) {
      entered.resolve();
      await resume.promise;
      return original.call(this);
    });
    const opening = createZenFsPod({ mounts: [{ name: 'root', path: '/', mode: 'rw', source: { kind: 'backend', backend: 'memory' } }] }, { proc: false });
    await entered.promise;
    const session = createStorageSession({ policy: 'memory' });
    sessions.push(session);
    await expect(session.open()).rejects.toThrow('raw storage operation is in progress');
    resume.resolve();
    pods.push(await opening);
    const protectedRoot = await session.open();
    await protectedRoot.zfs.promises.writeFile('/repo/private', 'private session contents');
    expect(await protectedRoot.zfs.promises.readFile('/repo/private', 'utf8')).toBe('private session contents');
  });
});
