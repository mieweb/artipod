import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileBuffer } from '../../../src/host/file-buffer';

const mocks = vi.hoisted(() => {
  const key = {} as CryptoKey;
  const disk = { content: 'saved baseline', generation: 0, keyAvailable: true };
  const source = {
    promises: {
      mkdir: vi.fn(async () => {}),
      readFile: vi.fn(async () => disk.content),
      writeFile: vi.fn(async (_path: string, text: string) => { if (disk.generation > 1) disk.content = text; }),
    },
    readFileSync: vi.fn(() => disk.content),
  };
  const vault = { filesystem: {}, backend: 'opfs', flush: vi.fn(async () => {}), close: vi.fn(async () => {}), adoptKey: vi.fn(async () => {}), reset: vi.fn() };
  const reopened = { ...vault, flush: vi.fn(async () => {}), close: vi.fn(async () => {}), adoptKey: vi.fn(async () => {}) };
  return {
    key, disk, source, vault, reopened,
    svc: {
      getKey: vi.fn(() => key), requireKey: vi.fn(() => key), storagePolicy: 'encrypted',
      setOfflineWriter: vi.fn(), flushOfflinePreference: vi.fn(async () => {}),
    },
    storage: {
      browserVaultRequired: vi.fn(async () => true), loadBackendPref: vi.fn(() => null),
      openBrowserVault: vi.fn(async () => vault), configureStorageRoot: vi.fn(async () => source),
    },
  };
});

vi.mock('@artipod/core/sandbox', () => mocks.storage);
vi.mock('../lib/boot', () => ({ keys: () => mocks.svc }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('window', {});
  mocks.disk.content = 'saved baseline';
  mocks.disk.generation = 0;
  mocks.disk.keyAvailable = true;
  mocks.svc.requireKey.mockImplementation(() => {
    if (!mocks.disk.keyAvailable) throw new Error('EACCES: lease unavailable');
    return mocks.key;
  });
  mocks.vault.adoptKey.mockImplementation(async () => { mocks.svc.requireKey(); });
  mocks.vault.flush.mockImplementation(async () => {});
  mocks.vault.close.mockImplementation(async () => {});
  mocks.storage.openBrowserVault.mockImplementation(async () => mocks.disk.generation ? mocks.reopened : mocks.vault);
  mocks.storage.configureStorageRoot.mockImplementation(async () => { mocks.disk.generation += 1; return mocks.source; });
});

async function failedRoot(failure: Error) {
  const filesystem = await import('../lib/filesystem');
  await filesystem.initFileSystem();
  mocks.vault.flush.mockRejectedValue(failure);
  mocks.vault.close.mockRejectedValue(failure);
  await expect(filesystem.initFileSystem()).rejects.toBe(failure);
  expect(filesystem.fileSystemNeedsRecovery()).toBe(true);
  return filesystem;
}

describe('authenticated recovery of a failed encrypted browser root', () => {
  it.each(['release', 'expiry'])('recovers after %s during a pending write, retaining drafts and the saved baseline', async () => {
    const filesystem = await import('../lib/filesystem');
    const { editorDrafts } = await import('../lib/services/editor-drafts');
    await filesystem.initFileSystem();
    const oldFs = filesystem.fs;
    const buffer = await FileBuffer.open({ zfs: oldFs, path: '/note.txt' });
    const detach = editorDrafts.attach('scratch:recover', buffer.path, buffer, () => {});
    buffer.setContent('private unsaved draft');
    const failure = new Error('EACCES: lease lost during queued encryption');
    let finishEncryption!: () => void;
    const encrypting = new Promise<void>(resolve => { finishEncryption = resolve; });
    mocks.vault.flush.mockImplementation(async () => { await encrypting; if (!mocks.disk.keyAvailable) throw failure; });
    const saved = buffer.save();
    await vi.waitFor(() => expect(mocks.source.promises.writeFile).toHaveBeenCalledOnce());
    mocks.disk.keyAvailable = false;
    finishEncryption();
    await expect(saved).rejects.toBe(failure);
    expect(buffer.isDirty).toBe(true);
    detach(); buffer.dispose();

    mocks.disk.keyAvailable = true;
    mocks.vault.flush.mockRejectedValue(failure); // Sticky failure survives re-login.
    mocks.vault.close.mockRejectedValue(failure);
    await expect(filesystem.initFileSystem()).rejects.toBe(failure);
    let finishTeardown!: () => void;
    const disposing = new Promise<void>(resolve => { finishTeardown = resolve; });
    const teardown = filesystem.registerFileSystemTeardown(async () => {
      await disposing;
      throw new filesystem.FileSystemClosePersistenceError(new Error('EACCES: key missing during close'));
    }, 'Workspace session');
    void teardown().catch(() => {}); // React may start this before the user clicks recovery.
    const recovering = filesystem.recoverFileSystem();
    await vi.waitFor(() => expect(mocks.svc.setOfflineWriter).toHaveBeenLastCalledWith(null));
    expect(mocks.vault.close).not.toHaveBeenCalled();
    expect(mocks.storage.openBrowserVault).toHaveBeenCalledOnce();
    await expect(oldFs.promises.readFile('/note.txt')).rejects.toThrow('closed for recovery');
    finishTeardown();
    const result = await recovering;
    expect(result.warning).toMatch(/Some changes could not be saved; editor drafts remain in this tab/);
    expect(mocks.vault.close).toHaveBeenCalledOnce();
    expect(mocks.storage.openBrowserVault).toHaveBeenCalledTimes(2);
    expect(mocks.disk.content).toBe('saved baseline');
    expect(editorDrafts.read('scratch:recover', '/note.txt')).toEqual({ content: 'private unsaved draft', savedContent: 'saved baseline' });
    expect(() => oldFs.readFileSync('/note.txt')).toThrow('closed for recovery');
    await expect(oldFs.promises.writeFile('/note.txt', 'late old write')).rejects.toThrow('closed for recovery');

    const restored = await FileBuffer.open({ zfs: filesystem.fs, path: '/note.txt' });
    const off = editorDrafts.attach('scratch:recover', restored.path, restored, () => {});
    expect(restored.content).toBe('private unsaved draft');
    expect(restored.isDirty).toBe(true);
    await restored.save();
    expect(mocks.disk.content).toBe('private unsaved draft');
    expect(editorDrafts.read('scratch:recover', restored.path)).toBeNull();
    expect(filesystem.fileSystemNeedsRecovery()).toBe(false);
    off(); restored.dispose();
  });

  it('authenticates the renewed key before disposing or closing the failed root', async () => {
    const failure = new Error('sticky write failure');
    const filesystem = await failedRoot(failure);
    const teardown = vi.fn(async () => {});
    filesystem.registerFileSystemTeardown(teardown);
    mocks.vault.adoptKey.mockRejectedValue(new Error('renewed key does not authenticate the saved generation'));
    await expect(filesystem.recoverFileSystem()).rejects.toThrow('renewed key does not authenticate');
    expect(teardown).not.toHaveBeenCalled();
    expect(mocks.vault.close).not.toHaveBeenCalled();
    expect(mocks.storage.openBrowserVault).toHaveBeenCalledOnce();
  });

  it.each(['adoption', 'flush'])('rejects an old initialization delayed during %s without touching the replacement or marking it failed', async stage => {
    const failure = new Error('sticky write failure');
    const filesystem = await failedRoot(failure);
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    if (stage === 'adoption') mocks.vault.adoptKey.mockImplementationOnce(async () => { entered(); await gate; });
    else mocks.vault.flush.mockImplementationOnce(async () => { entered(); await gate; throw new Error('late old flush failure'); });
    const oldOpening = filesystem.initFileSystem();
    void oldOpening.catch(() => {});
    await started;
    await filesystem.recoverFileSystem();
    const replacementFlushes = mocks.reopened.flush.mock.calls.length;
    finish();
    await expect(oldOpening).rejects.toThrow('storage changed while initialization was completing');
    expect(mocks.reopened.flush).toHaveBeenCalledTimes(replacementFlushes);
    expect(filesystem.fileSystemNeedsRecovery()).toBe(false);
    await expect(filesystem.initFileSystem()).resolves.toMatchObject({ encrypted: true });
  });

  it('retains a prior teardown failure and reports it instead of remounting over undisposed consumers', async () => {
    const failure = new Error('sticky write failure');
    const filesystem = await failedRoot(failure);
    const teardown = filesystem.registerFileSystemTeardown(async () => { throw new Error('runtime disposal failed'); }, 'Workspace session');
    await expect(teardown()).rejects.toThrow('runtime disposal failed');
    await expect(filesystem.recoverFileSystem()).rejects.toThrow('Workspace session teardown failed: runtime disposal failed');
    await expect(filesystem.recoverFileSystem()).rejects.toThrow('Workspace session teardown failed: runtime disposal failed');
    expect(mocks.vault.close).not.toHaveBeenCalled();
    expect(mocks.storage.openBrowserVault).toHaveBeenCalledOnce();
  });

  it('reports reopen failure, keeps recovery available, and retries opening rather than caching the failed replacement', async () => {
    const failure = new Error('sticky write failure');
    const filesystem = await failedRoot(failure);
    mocks.storage.openBrowserVault.mockRejectedValueOnce(new Error('ciphertext unavailable'));
    await expect(filesystem.recoverFileSystem()).rejects.toThrow('ciphertext unavailable. Unsaved editor drafts remain in this tab');
    expect(filesystem.fileSystemNeedsRecovery()).toBe(true);
    const recovered = await filesystem.recoverFileSystem();
    expect(recovered.info.encrypted).toBe(true);
    expect(filesystem.fileSystemNeedsRecovery()).toBe(false);
    expect(mocks.storage.openBrowserVault).toHaveBeenCalledTimes(3);
  });
});
