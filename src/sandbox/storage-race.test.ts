import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemory, InMemoryStore, StoreFS, fs, mounts, umount } from '@zenfs/core';
import { IndexedDB } from '@zenfs/dom';
import { createStorageSession, type StorageSession } from '../storage/session.js';
import { configureStorageRoot, createMemoryStorageRoot, initFileSystem, migrateStorage, mountBackend, mountConfigForSpec, unmountBackend } from './storage.js';

const PRIVATE = 'PRIVATE-newly-protected-patient-data';
const sessions: StorageSession[] = [];
const pending: Promise<unknown>[] = [];
const resumeAll: Array<() => void> = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}
function session() {
  const value = createStorageSession({ policy: 'memory' });
  sessions.push(value);
  return value;
}
class RecordingStore extends InMemoryStore {
  writes: Uint8Array[] = [];
  set(id: number, bytes: Uint8Array): this { this.writes.push(bytes.slice()); return super.set(id, bytes); }
}
async function plaintextBackend(pause = true) {
  // Exercise real StoreFS initialization and copy operations while pausing the
  // browser backend's public create seam; no browser database is needed here.
  const store = new RecordingStore();
  const root = new StoreFS(store);
  await root.ready();
  const entered = deferred();
  const resume = deferred();
  resumeAll.push(resume.resolve);
  vi.stubGlobal('indexedDB', { databases: async () => [] });
  vi.spyOn(IndexedDB, 'isAvailable').mockResolvedValue(true);
  vi.spyOn(IndexedDB, 'create').mockImplementationOnce(async () => {
    entered.resolve();
    if (pause) await resume.promise;
    return root as unknown as Awaited<ReturnType<typeof IndexedDB.create>>;
  });
  return { root, store, entered, resume };
}
function assertNoPrivateWrites(store: RecordingStore) {
  expect(store.writes.some(bytes => new TextDecoder().decode(bytes).includes(PRIVATE))).toBe(false);
}
async function protectedAttempt() {
  let error: unknown;
  try {
    const info = await session().open();
    // Against the old race, activation succeeds while raw migration is paused.
    // This fresh protected file must never be copied to its plaintext target.
    await info.zfs.promises.writeFile('/patient.csv', PRIVATE);
  } catch (failure) { error = failure; }
  return error;
}
beforeEach(async () => { await configureStorageRoot(await createMemoryStorageRoot()); });
afterEach(async () => {
  resumeAll.splice(0).forEach(resume => resume());
  await Promise.allSettled(pending.splice(0));
  vi.restoreAllMocks();
  await Promise.allSettled(sessions.splice(0).map(value => value.close()));
  for (const path of [...mounts.keys()].sort((a, b) => b.length - a.length)) umount(path);
  vi.unstubAllGlobals();
});

describe('raw storage operation exclusion', () => {
  it.each(['init', 'migrate', 'mount'] as const)('holds %s ownership through a delayed plaintext backend', async kind => {
    await fs.promises.writeFile('/public.txt', 'ordinary plaintext source');
    const target = await plaintextBackend();
    const operation = track<unknown>(kind === 'init'
      ? initFileSystem('indexeddb', { storagePolicy: 'plaintext' })
      : kind === 'migrate'
        ? migrateStorage('indexeddb', undefined, { storagePolicy: 'plaintext' })
        : mountBackend('/plain', { type: 'indexeddb' }, { storagePolicy: 'plaintext' }));
    await target.entered.promise;
    const activationError = await protectedAttempt();
    target.resume.resolve();
    await operation;
    expect.soft((activationError as Error | undefined)?.message).toMatch(/raw storage operation/);
    assertNoPrivateWrites(target.store);
    expect(await target.root.exists('/patient.csv')).toBe(false);
    // Successful completion releases exclusion, so a fresh managed activation
    // can proceed without retaining the raw root or mount's ownership.
    const current = await session().open();
    await current.zfs.promises.writeFile('/patient.csv', PRIVATE);
    expect(await current.zfs.promises.readFile('/patient.csv', 'utf8')).toBe(PRIVATE);
    assertNoPrivateWrites(target.store);
  });

  it.each([false, true])('holds migration ownership through copying and cleanup (copy failure: %s)', async fail => {
    await fs.promises.writeFile('/patient.csv', 'ordinary plaintext source');
    const target = await plaintextBackend(false);
    const entered = deferred();
    const resume = deferred();
    resumeAll.push(resume.resolve);
    const source = mounts.get('/')!;
    const readdir = source.readdir.bind(source);
    vi.spyOn(source, 'readdir').mockImplementationOnce(async path => {
      entered.resolve();
      await resume.promise;
      if (fail) throw new Error('Injected copy failure');
      return readdir(path);
    });
    const copying = track(migrateStorage('indexeddb', undefined, { storagePolicy: 'plaintext' }));
    await entered.promise;
    const activationError = await protectedAttempt();
    resume.resolve();
    if (fail) await expect(copying).rejects.toThrow('Injected copy failure');
    else await copying;
    expect.soft((activationError as Error | undefined)?.message).toMatch(/raw storage operation/);
    assertNoPrivateWrites(target.store);
    expect(mounts.has('/__migrate')).toBe(false);
    expect(await fs.promises.readFile('/patient.csv', 'utf8')).toBe('ordinary plaintext source');
    expect((await session().open()).protection).toBe('volatile');
  });

  it('holds mount-config ownership through an OPFS handle await', async () => {
    const entered = deferred();
    const resume = deferred();
    resumeAll.push(resume.resolve);
    const directory = { getDirectoryHandle: async () => directory, async *entries() {} };
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => { entered.resolve(); await resume.promise; return directory; } } });
    const config = track(mountConfigForSpec({ type: 'opfs' }, { storagePolicy: 'plaintext' }));
    await entered.promise;
    const activationError = await protectedAttempt();
    resume.resolve();
    await config;
    expect((activationError as Error | undefined)?.message).toMatch(/raw storage operation/);
    expect((await session().open()).protection).toBe('volatile');
  });

  it('reserves unmount ownership before its dynamic import', async () => {
    await mountBackend('/scratch', { type: 'memory' });
    const next = await createMemoryStorageRoot();
    const removing = track(unmountBackend('/scratch'));
    await expect(configureStorageRoot(next)).rejects.toThrow('raw storage operation');
    await removing;
    expect(mounts.has('/scratch')).toBe(false);
    await configureStorageRoot(next);
  });

  it('blocks every raw entry while managed configuration is awaiting its real filesystem', async () => {
    const other = await createMemoryStorageRoot();
    const root = InMemory.create({});
    await root.ready();
    const ready = root.ready.bind(root);
    const entered = deferred();
    const resume = deferred();
    resumeAll.push(resume.resolve);
    let calls = 0;
    vi.spyOn(root, 'ready').mockImplementation(async () => {
      // First ready creates the root; second ready is inside configure after
      // the core has reserved ownership, before it can activate the mount.
      if (++calls === 2) { entered.resolve(); await resume.promise; }
      await ready();
    });
    vi.spyOn(InMemory, 'create').mockReturnValueOnce(root);
    const opening = track(session().open());
    await entered.promise;
    await expect(initFileSystem('memory')).rejects.toThrow('root configuration');
    await expect(migrateStorage('memory')).rejects.toThrow('root configuration');
    await expect(mountBackend('/scratch', { type: 'memory' })).rejects.toThrow('root configuration');
    await expect(mountConfigForSpec({ type: 'memory' })).rejects.toThrow('root configuration');
    await expect(unmountBackend('/')).rejects.toThrow('root configuration');
    await expect(configureStorageRoot(other)).rejects.toThrow('root configuration');
    resume.resolve();
    const info = await opening;
    await info.zfs.promises.writeFile('/patient.csv', PRIVATE);
    await mountBackend('/scratch', { type: 'memory' });
    await info.zfs.promises.writeFile('/scratch/transient.txt', 'volatile child');
    await unmountBackend('/scratch');
    expect(await info.zfs.promises.readFile('/patient.csv', 'utf8')).toBe(PRIVATE);
  });

  it('releases raw leases after invalid input and backend errors', async () => {
    await expect(mountBackend('relative', { type: 'memory' })).rejects.toThrow('absolute');
    await expect(unmountBackend('/missing')).rejects.toThrow('not mounted');
    await expect(mountConfigForSpec({ type: 'indexeddb' })).rejects.toThrow('plaintext');
    await expect(initFileSystem('indexeddb')).rejects.toThrow('plaintext');
    const target = await plaintextBackend(false);
    vi.mocked(IndexedDB.create).mockRejectedValueOnce(new Error('Injected backend failure'));
    // Consume the successful create first so the following failure is the
    // backend's failure, rather than an unrelated policy rejection.
    await mountBackend('/first', { type: 'indexeddb' }, { storagePolicy: 'plaintext' });
    await unmountBackend('/first');
    await expect(mountBackend('/failed', { type: 'indexeddb' }, { storagePolicy: 'plaintext' })).rejects.toThrow('Injected backend failure');
    vi.mocked(IndexedDB.create).mockRejectedValueOnce(new Error('Injected initialization failure'));
    await expect(initFileSystem('indexeddb', { storagePolicy: 'plaintext' })).rejects.toThrow('Injected initialization failure');
    expect((await session().open()).protection).toBe('volatile');
    assertNoPrivateWrites(target.store);
  });

  it('releases a failed configure reservation before a raw operation or managed retry', async () => {
    const root = await createMemoryStorageRoot();
    vi.spyOn(root, 'ready').mockRejectedValueOnce(new Error('Injected configure failure'));
    await expect(configureStorageRoot(root)).rejects.toThrow('Injected configure failure');
    await mountConfigForSpec({ type: 'memory' });
    expect((await session().open()).protection).toBe('volatile');
  });
});
