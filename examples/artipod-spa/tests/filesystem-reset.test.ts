import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const key = {} as CryptoKey;
  const source = { promises: { mkdir: vi.fn(async () => {}), writeFile: vi.fn(async () => {}) } };
  const vault = {
    filesystem: {}, backend: 'opfs', flush: vi.fn(async () => {}), close: vi.fn(async () => {}),
    adoptKey: vi.fn(async () => {}), reset: vi.fn(async () => ({ warnings: [] as string[] })),
  };
  const finishKeys = vi.fn();
  return {
    key, source, vault, finishKeys,
    svc: {
      getKey: vi.fn((): CryptoKey | null => key), requireKey: vi.fn(() => key), storagePolicy: 'encrypted', setOfflineWriter: vi.fn(),
      flushOfflinePreference: vi.fn(async () => {}),
      suspendForReset: vi.fn(async () => finishKeys),
    },
    storage: {
      browserVaultRequired: vi.fn(async () => false), loadBackendPref: vi.fn(() => null),
      openBrowserVault: vi.fn(async () => vault), configureStorageRoot: vi.fn(async () => source),
      createMemoryStorageRoot: vi.fn(async () => ({})), resetBrowserVault: vi.fn(async () => ({ warnings: [] as string[] })),
    },
  };
});

vi.mock('@artipod/core/sandbox', () => mocks.storage);
vi.mock('../lib/boot', () => ({ keys: () => mocks.svc }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('window', {});
  mocks.svc.getKey.mockImplementation(() => mocks.key);
  mocks.svc.suspendForReset.mockImplementation(async () => mocks.finishKeys);
  mocks.svc.flushOfflinePreference.mockImplementation(async () => {});
  mocks.svc.storagePolicy = 'encrypted';
  mocks.storage.openBrowserVault.mockImplementation(async () => mocks.vault);
  mocks.storage.resetBrowserVault.mockImplementation(async () => ({ warnings: [] }));
  mocks.vault.reset.mockImplementation(async () => ({ warnings: [] }));
  mocks.vault.adoptKey.mockImplementation(async () => {});
});

describe('confirmed browser filesystem reset', () => {
  it('adopts the resumed root key before persisting a pending reconnect preference', async () => {
    const filesystem = await import('../lib/filesystem');
    await filesystem.initFileSystem();
    const order: string[] = [];
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    mocks.vault.adoptKey.mockImplementation(async () => { order.push('adopt'); });
    mocks.svc.flushOfflinePreference.mockImplementation(async () => { order.push('persist'); await gate; });
    let resumed = false;
    const reopening = filesystem.initFileSystem().then(() => { resumed = true; });
    await vi.waitFor(() => expect(order).toEqual(['adopt', 'persist']));
    expect(resumed).toBe(false);
    finish();
    await reopening;
    expect(resumed).toBe(true);
  });

  it('uses the owned vault reset without releasing its locks via close first', async () => {
    const filesystem = await import('../lib/filesystem');
    await filesystem.initFileSystem();
    mocks.vault.reset.mockResolvedValue({ warnings: ['A failed write was discarded during reset'] });
    const result = await filesystem.resetFileSystem();
    expect(mocks.vault.reset).toHaveBeenCalledOnce();
    expect(mocks.vault.close).not.toHaveBeenCalled();
    expect(mocks.storage.resetBrowserVault).not.toHaveBeenCalled();
    expect(result.warnings).toEqual(['A failed write was discarded during reset']);
    expect(filesystem.fsInfo).toBeNull();
    expect(mocks.svc.setOfflineWriter).toHaveBeenLastCalledWith(null);
    expect(mocks.svc.suspendForReset).toHaveBeenCalledOnce();
    expect(mocks.finishKeys).toHaveBeenCalledOnce();
  });

  it('takes the standalone reset lock in memory-only mode', async () => {
    mocks.svc.getKey.mockReturnValue(null);
    mocks.svc.storagePolicy = 'plaintext';
    const filesystem = await import('../lib/filesystem');
    await filesystem.initFileSystem();
    await filesystem.resetFileSystem();
    expect(mocks.storage.resetBrowserVault).toHaveBeenCalledOnce();
    expect(mocks.vault.close).not.toHaveBeenCalled();
    expect(mocks.vault.reset).not.toHaveBeenCalled();
  });

  it('blocks new initialization and mutations until the reset finishes', async () => {
    const filesystem = await import('../lib/filesystem');
    await filesystem.initFileSystem();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    mocks.vault.reset.mockImplementation(async () => { await gate; return { warnings: [] }; });
    const resetting = filesystem.resetFileSystem();
    await vi.waitFor(() => expect(mocks.vault.reset).toHaveBeenCalledOnce());
    await expect(filesystem.initFileSystem()).rejects.toThrow('reset is in progress');
    await expect(filesystem.fs.promises.writeFile('/new.csv', 'later')).rejects.toThrow('reset is in progress');
    expect(mocks.source.promises.writeFile).not.toHaveBeenCalled();
    const closing = filesystem.closeFileSystem();
    finish();
    await resetting;
    await closing;
    expect(mocks.vault.close).not.toHaveBeenCalled();
  });

  it('propagates deletion failures and allows an explicit standalone retry', async () => {
    const filesystem = await import('../lib/filesystem');
    await filesystem.initFileSystem();
    mocks.vault.reset.mockRejectedValue(new Error('Deletion failed'));
    await expect(filesystem.resetFileSystem()).rejects.toThrow('Deletion failed');
    expect(mocks.vault.close).not.toHaveBeenCalled();
    expect(mocks.finishKeys).toHaveBeenCalledOnce();
    await filesystem.resetFileSystem();
    expect(mocks.storage.resetBrowserVault).toHaveBeenCalledOnce();
    await expect(filesystem.initFileSystem()).rejects.toThrow('reset is in progress');
  });

  it('drains key-service persistence before touching backing deletion and drops keys only afterward', async () => {
    const filesystem = await import('../lib/filesystem');
    await filesystem.initFileSystem();
    let finishDrain!: () => void;
    const draining = new Promise<void>(resolve => { finishDrain = resolve; });
    mocks.svc.suspendForReset.mockImplementation(async () => { await draining; return mocks.finishKeys; });
    mocks.vault.reset.mockImplementation(async () => {
      expect(mocks.finishKeys).not.toHaveBeenCalled();
      return { warnings: [] };
    });
    const resetting = filesystem.resetFileSystem();
    await vi.waitFor(() => expect(mocks.svc.suspendForReset).toHaveBeenCalledOnce());
    expect(mocks.vault.reset).not.toHaveBeenCalled();
    finishDrain();
    await resetting;
    expect(mocks.vault.reset).toHaveBeenCalledOnce();
    expect(mocks.finishKeys).toHaveBeenCalledOnce();
  });
});
