import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@zenfs/core';
import { createZenFsPod } from '../realize/zenfs.js';
import { readPodSettings } from '../oci/settings.js';
import { generateBlobKey, importBlobKey, isEncryptedBlob } from '../oci/cipher.js';
import { configureStorageRoot, createMemoryStorageRoot } from '../sandbox/storage.js';
import { createStorageSession, StorageClosePersistenceError, type StorageSession } from './session.js';
import type { BrowserVaultAdapters, BrowserVaultControl } from './browser-vault.js';
import type { StorageKeyProvider } from './keys.js';

const NAME = 'PRIVATE-patient-name.csv';
const BODY = 'PRIVATE-clinical-payload';

class RawStore extends InMemoryStore {
  writes: Uint8Array[] = [];
  failure: Error | null = null;
  beforeSync?: () => Promise<void>;
  set(id: number, bytes: Uint8Array): this {
    if (this.failure) throw this.failure;
    this.writes.push(bytes.slice());
    return super.set(id, bytes);
  }
  close(): void {}
  async sync(): Promise<void> { await this.beforeSync?.(); await super.sync(); }
}

class RawAdapters implements BrowserVaultAdapters {
  backend = 'indexeddb' as const;
  control: BrowserVaultControl | null = null;
  stores = new Map<string, RawStore>();
  owned = false;
  erased = false;
  beforeErase?: () => Promise<void>;
  beforeSync?: () => Promise<void>;
  readControl = vi.fn(async () => this.control && structuredClone(this.control));
  writeControl = vi.fn(async (control: BrowserVaultControl) => { this.control = structuredClone(control); });
  async acquireWriter() {
    if (this.owned) throw new Error('Another writer owns storage');
    this.owned = true;
    return () => { this.owned = false; };
  }
  async generation(id: string, mode: 'create' | 'open') {
    if (mode === 'create') {
      const store = new RawStore();
      store.beforeSync = () => this.beforeSync?.() ?? Promise.resolve();
      this.stores.set(id, store);
    }
    const store = this.stores.get(id);
    if (!store) throw new Error('Missing generation');
    return { kind: 'store' as const, store };
  }
  async removeGeneration(id: string) { this.stores.delete(id); }
  async legacySources() { return []; }
  async erase() {
    expect(this.owned).toBe(true);
    await this.beforeErase?.();
    this.stores.clear(); this.control = null; this.erased = true;
  }
  get store(): RawStore { return this.stores.get(this.control!.generation!)!; }
  assertCiphertext() {
    expect(this.store.writes.length).toBeGreaterThan(0);
    for (const bytes of this.store.writes) {
      expect(isEncryptedBlob(bytes)).toBe(true);
      expect(new TextDecoder().decode(bytes)).not.toContain('PRIVATE');
    }
    expect(JSON.stringify(this.control)).not.toContain('PRIVATE');
  }
}

function keyProvider(initial: CryptoKey | null) {
  let key = initial;
  const finishReset = vi.fn(() => { key = null; });
  const keys: StorageKeyProvider = {
    getKey: () => key,
    requireKey: () => { if (!key) throw new Error('EACCES: lease unavailable'); return key; },
    storagePolicy: 'encrypted',
    suspendForReset: vi.fn(async () => finishReset),
    setOfflineWriter: vi.fn(), flushOfflinePreference: vi.fn(async () => {}),
  };
  return { keys, finishReset, setKey: (value: CryptoKey | null) => { key = value; } };
}

const sessions: StorageSession[] = [];
const emergencyTeardowns: Array<() => void> = [];
function session(options: ConstructorParameters<typeof StorageSession>[0]) {
  const value = createStorageSession(options); sessions.push(value); return value;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(async () => {
  vi.restoreAllMocks();
  emergencyTeardowns.splice(0).forEach(close => close());
  await Promise.allSettled(sessions.splice(0).map(value => value.close()));
});

describe('framework-free core storage session', () => {
  it.each(['', '.', '..', 'invalid\0ref', null, undefined])('rejects invalid workspace ref %j before opening a closed session', async ref => {
    const adapters = new RawAdapters();
    const { keys } = keyProvider(await generateBlobKey());
    const value = session({ adapters, keys });
    await expect(value.openWorkspaceUpper(ref as unknown as string)).rejects.toThrow('Invalid workspace reference');
    expect(adapters.writeControl).not.toHaveBeenCalled();
    expect(adapters.stores.size).toBe(0);
    expect(adapters.owned).toBe(false);
  });

  it('requires a key for protected default before creating bootstrap or filesystem metadata', async () => {
    const adapters = new RawAdapters();
    const value = session({ adapters });
    await expect(value.open()).rejects.toThrow('encryption key');
    expect(adapters.writeControl).not.toHaveBeenCalled();
    expect(adapters.stores.size).toBe(0);
    expect(adapters.owned).toBe(false);
  });

  it('rejects recovery until initial metadata persistence and its cleanup have settled', async () => {
    const adapters = new RawAdapters();
    const { keys } = keyProvider(await generateBlobKey());
    const value = session({ adapters, keys });
    const flushing = deferred();
    const release = deferred();
    adapters.beforeSync = async () => {
      if (value.getSnapshot().protection === 'encrypted') { flushing.resolve(); await release.promise; }
    };
    const opening = value.open();
    await flushing.promise;
    expect(value.getSnapshot().status).toBe('opening');
    await expect(value.recover()).rejects.toThrow('Storage is opening');
    expect(adapters.owned).toBe(true);
    release.resolve();
    const original = await opening;
    const result = await value.recover();
    expect(result.info).not.toBe(original);
    expect(adapters.owned).toBe(true);
    const writer = vi.mocked(keys.setOfflineWriter!).mock.lastCall?.[0];
    expect(typeof writer).toBe('function');
    await writer?.(true);
    expect(await readPodSettings(result.info.zfs)).toMatchObject({ offline: true });
  });

  it('keeps bootstrap guarded when failed persistence publishes before opening cleanup finishes', async () => {
    const adapters = new RawAdapters();
    const { keys } = keyProvider(await generateBlobKey());
    const value = session({ adapters, keys });
    let attempted: ReturnType<StorageSession['recover']> | undefined;
    const unsubscribe = value.subscribe(() => {
      if (!attempted && value.getSnapshot().status === 'failed' && value.getSnapshot().protection) {
        attempted = value.recover();
        void attempted.catch(() => {});
      }
    });
    adapters.beforeSync = async () => {
      if (value.getSnapshot().protection) throw new Error('Initial durability failure');
    };
    await expect(value.open()).rejects.toThrow();
    expect(attempted).toBeDefined();
    await expect(attempted).rejects.toThrow('Storage is opening');
    expect(adapters.owned).toBe(false);
    unsubscribe();
  });

  it('refuses broker memory fallback when any saved bootstrap record exists', async () => {
    const adapters = new RawAdapters();
    adapters.control = {} as BrowserVaultControl;
    const provider = keyProvider(null);
    Object.defineProperty(provider.keys, 'storagePolicy', { value: 'plaintext' });
    const value = session({ adapters, keys: provider.keys, policy: 'broker' });
    await expect(value.open()).rejects.toThrow('encryption key');
    expect(adapters.stores.size).toBe(0);
    expect(adapters.writeControl).not.toHaveBeenCalled();
  });

  it('reports explicit memory mode as volatile and rejects concurrent root owners', async () => {
    const first = session({ policy: 'memory' });
    const second = session({ policy: 'memory' });
    const results = await Promise.allSettled([first.open(), second.open()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const opened = results.find(result => result.status === 'fulfilled');
    expect(opened?.status === 'fulfilled' && opened.value).toMatchObject({ backend: 'memory', protection: 'volatile', encrypted: false, memoryOnly: true });
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.message).toMatch(/owns the root/);
  });

  it('never labels an explicit plaintext filesystem as protected', async () => {
    const root = await createMemoryStorageRoot();
    const value = session({ policy: 'plaintext', filesystem: root });
    const info = await value.open();
    expect(info).toMatchObject({ protection: 'plaintext', encrypted: false, memoryOnly: false });
    await expect(createZenFsPod({ mounts: [{ name: 'root', path: '/', mode: 'rw', source: { kind: 'backend', backend: 'memory' } }] }, { storage: info, storagePolicy: 'protected' })).rejects.toThrow('Protected storage');
  });

  it('protects pod contents, names, refs, indexes, and settings through public storage adoption', async () => {
    const adapters = new RawAdapters();
    const { keys } = keyProvider(await generateBlobKey());
    const value = session({ adapters, keys });
    const info = await value.open();
    expect(info).toMatchObject({ encrypted: true, protection: 'encrypted', memoryOnly: false });
    const pod = await createZenFsPod({ mounts: [{ name: 'workspace', path: '/repo', mode: 'rw', source: { kind: 'backend', backend: 'indexeddb' } }] }, { storage: info, storagePolicy: 'protected', proc: false });
    await info.zfs.promises.writeFile(`/repo/${NAME}`, BODY);
    const snapshot = await pod.snapshots.create({ label: NAME });
    expect(snapshot).not.toBeNull();
    await info.flush();
    adapters.assertCiphertext();
    expect(pod.zfs).toBe(info.zfs);
    pod.dispose();
    const generation = info.generation;
    await value.close();
    const reopened = await value.open();
    expect(reopened.generation).toBe(generation);
    expect(await reopened.zfs.promises.readFile(`/repo/${NAME}`, 'utf8')).toBe(BODY);
  });

  it('rejects stale VFS and file handles after close and reopening', async () => {
    const value = session({ policy: 'memory' });
    const old = await value.open();
    await old.zfs.promises.writeFile('/repo/note', 'saved');
    const handle = await (old.zfs.promises as unknown as typeof import('@zenfs/core').fs.promises).open('/repo/note', 'r');
    const fd = old.zfs.openSync('/repo/note', 'r');
    await value.close();
    const fresh = await value.open();
    await fresh.zfs.promises.writeFile('/repo/note', 'new root');
    await expect(old.zfs.promises.readFile('/repo/note', 'utf8')).rejects.toThrow('closed for recovery');
    await expect(handle.readFile('utf8')).rejects.toThrow('closed for recovery');
    expect(() => fresh.zfs.readSync(fd, new Uint8Array(5), 0, 5, 0)).toThrow('bad file descriptor');
    expect(await fresh.zfs.promises.readFile('/repo/note', 'utf8')).toBe('new root');
  });

  it('rejects callback, stream, watcher, and iterator surfaces that cannot retain a session lifetime', async () => {
    const value = session({ policy: 'memory' });
    const info = await value.open();
    expect(() => info.zfs.open('/repo/note', 'w', () => {})).toThrow('unsupported');
    expect(() => info.zfs.createReadStream('/repo/note')).toThrow('unsupported');
    expect(() => info.zfs.promises.watch('/repo')).toThrow('unsupported');
    expect(() => info.zfs.promises.opendir('/repo')).toThrow('unsupported');
  });

  it('blocks new operations during close while allowing consumer persistence to drain', async () => {
    const value = session({ policy: 'memory' });
    const info = await value.open();
    const drain = deferred();
    let started = false;
    value.registerTeardown(async () => { started = true; await info.flush(); await drain.promise; });
    const closing = value.close();
    await vi.waitFor(() => expect(started).toBe(true));
    await expect(info.zfs.promises.writeFile('/repo/late', 'late')).rejects.toThrow('closing');
    await expect(configureStorageRoot(await createMemoryStorageRoot())).rejects.toThrow('owns the root');
    drain.resolve(); await closing;
  });

  it('authenticates a replacement key before disposing a failed generation and recovers its saved baseline', async () => {
    const adapters = new RawAdapters();
    const rawKey = new Uint8Array(32).fill(31);
    const key = await importBlobKey(rawKey);
    const provider = keyProvider(key);
    const value = session({ adapters, keys: provider.keys });
    const old = await value.open();
    await old.zfs.promises.writeFile('/repo/note', 'saved baseline');
    const failure = new Error('QuotaExceededError');
    adapters.store.failure = failure;
    await expect(old.zfs.promises.writeFile('/repo/note', 'unsaved draft')).rejects.toThrow();
    expect(value.needsRecovery()).toBe(true);
    const teardown = vi.fn(async () => {});
    value.registerTeardown(teardown);
    provider.setKey(await generateBlobKey());
    await expect(value.recover()).rejects.toThrow('Storage recovery failed');
    expect(teardown).not.toHaveBeenCalled();
    expect(adapters.owned).toBe(true);
    provider.setKey(await importBlobKey(rawKey));
    adapters.store.failure = null;
    const result = await value.recover();
    expect(result.warning).toMatch(/Some changes could not be saved/);
    expect(teardown).toHaveBeenCalledOnce();
    expect(await result.info.zfs.promises.readFile('/repo/note', 'utf8')).toBe('saved baseline');
    expect(value.needsRecovery()).toBe(false);
    await expect(old.zfs.promises.readFile('/repo/note', 'utf8')).rejects.toThrow('closed for recovery');
  });

  it('recovers a queued write rejected after lease loss without persisting its draft', async () => {
    const adapters = new RawAdapters();
    const rawKey = new Uint8Array(32).fill(51);
    const provider = keyProvider(await importBlobKey(rawKey));
    const value = session({ adapters, keys: provider.keys });
    const old = await value.open();
    await old.zfs.promises.writeFile('/repo/note', 'saved baseline');
    const encrypting = deferred();
    const release = deferred();
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args) => {
      encrypting.resolve(); await release.promise; return encrypt(...args);
    });
    const saving = old.zfs.promises.writeFile('/repo/note', 'private unsaved draft');
    void saving.catch(() => {});
    await encrypting.promise;
    provider.setKey(null);
    expect(adapters.owned).toBe(true);
    release.resolve();
    await expect(saving).rejects.toThrow();
    spy.mockRestore();
    expect(value.needsRecovery()).toBe(true);
    provider.setKey(await importBlobKey(rawKey));
    const result = await value.recover();
    expect(await result.info.zfs.promises.readFile('/repo/note', 'utf8')).toBe('saved baseline');
    expect(result.warning).toMatch(/Some changes could not be saved/);
    adapters.assertCiphertext();
  });

  it('closes the replacement root when close is requested during recovery', async () => {
    const adapters = new RawAdapters();
    const { keys } = keyProvider(await generateBlobKey());
    const value = session({ adapters, keys });
    const info = await value.open();
    const teardown = deferred();
    let started = false;
    value.registerTeardown(async () => { started = true; await teardown.promise; });
    const recovering = value.recover();
    await vi.waitFor(() => expect(started).toBe(true));
    const closing = value.close();
    await expect(info.zfs.promises.readFile('/repo/note', 'utf8')).rejects.toThrow(/closed for recovery|recovery is in progress/);
    teardown.resolve();
    await recovering; await closing;
    expect(adapters.owned).toBe(false);
    expect(value.getSnapshot().status).toBe('closed');
  });

  it('retains ownership and failed teardown across repeated reset attempts', async () => {
    const adapters = new RawAdapters();
    const { keys } = keyProvider(await generateBlobKey());
    const value = session({ adapters, keys });
    await value.open();
    const failure = new Error('Worker did not stop');
    const teardown = vi.fn(async () => { throw failure; });
    value.registerTeardown(teardown, 'Worker');
    await expect(value.reset()).rejects.toThrow('Worker teardown failed');
    await expect(value.reset()).rejects.toThrow('Worker teardown failed');
    expect(teardown).toHaveBeenCalledOnce();
    expect(adapters.erased).toBe(false);
    expect(adapters.owned).toBe(true);
    await expect(configureStorageRoot(await createMemoryStorageRoot())).rejects.toThrow('owns the root');
    // A failed external consumer is intentionally retained. Release only the
    // test fixture's retained callbacks so later tests can own the singleton.
    emergencyTeardowns.push(() => { (value as unknown as { consumers: Map<unknown, unknown> }).consumers.clear(); });
  });

  it('waits for key persistence and backing deletion, retaining writer ownership throughout reset', async () => {
    const adapters = new RawAdapters();
    const provider = keyProvider(await generateBlobKey());
    const value = session({ adapters, keys: provider.keys });
    const info = await value.open();
    const keyDrain = deferred();
    const deleting = deferred();
    let eraseStarted = false;
    vi.mocked(provider.keys.suspendForReset).mockImplementation(async () => { await keyDrain.promise; return provider.finishReset; });
    adapters.beforeErase = async () => { eraseStarted = true; await deleting.promise; };
    value.registerTeardown(async () => { throw new StorageClosePersistenceError(new Error('lease expired during final save')); });
    const resetting = value.reset();
    await vi.waitFor(() => expect(provider.keys.suspendForReset).toHaveBeenCalledOnce());
    expect(eraseStarted).toBe(false);
    expect(provider.finishReset).not.toHaveBeenCalled();
    await expect(info.zfs.promises.writeFile('/repo/late', BODY)).rejects.toThrow('reset is in progress');
    keyDrain.resolve();
    await vi.waitFor(() => expect(eraseStarted).toBe(true));
    expect(adapters.owned).toBe(true);
    expect(provider.finishReset).not.toHaveBeenCalled();
    deleting.resolve();
    const result = await resetting;
    expect(result.warnings.join(' ')).toMatch(/could not save all changes/);
    expect(adapters.erased).toBe(true);
    expect(adapters.owned).toBe(false);
    expect(provider.finishReset).toHaveBeenCalledOnce();
  });

  it('disposes an open dirty handle after lease release before confirmed reset erases backing', async () => {
    const adapters = new RawAdapters();
    const provider = keyProvider(await generateBlobKey());
    const value = session({ adapters, keys: provider.keys });
    const info = await value.open();
    await info.zfs.promises.writeFile('/repo/note', 'saved');
    const handle = await info.zfs.promises.open('/repo/note', 'r+');
    await handle.writeFile('saved through open handle');
    provider.setKey(null);
    adapters.beforeErase = async () => {
      // Core force-disposes its known ZenFS handles when normal close can
      // no longer flush; deletion begins only after that disposal completes.
      expect((handle as unknown as { vfs: { isClosed: boolean } }).vfs.isClosed).toBe(true);
    };
    const result = await value.reset();
    expect(result.warnings.join(' ')).toMatch(/could not save|could not be saved/);
    expect(adapters.erased).toBe(true);
    expect(adapters.owned).toBe(false);
    expect(provider.finishReset).toHaveBeenCalledOnce();
    await expect(handle.readFile('utf8')).rejects.toThrow('reset is in progress');
  });

  it('keeps external-store snapshots stable while their metadata is unchanged', async () => {
    const value = session({ policy: 'memory' });
    expect(value.getSnapshot()).toBe(value.getSnapshot());
    await value.open();
    expect(value.getSnapshot()).toBe(value.getSnapshot());
  });
});
