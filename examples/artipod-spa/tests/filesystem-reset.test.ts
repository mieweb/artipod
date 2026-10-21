import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const source = { promises: { writeFile: vi.fn() } };
  const info = { zfs: source, backend: 'opfs', encrypted: true, memoryOnly: false, isPrimaryTab: true };
  const session = {
    open: vi.fn(async () => info), flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}), reset: vi.fn(async () => ({ warnings: [] as string[] })),
  };
  return { info, session, keys: vi.fn(() => ({})), create: vi.fn((_options: unknown) => session), pref: vi.fn((): string | null => null) };
});
vi.mock('@artipod/core/storage', () => ({ createStorageSession: mocks.create, StorageClosePersistenceError: class extends Error {} }));
vi.mock('@artipod/core/sandbox', () => ({ loadBackendPref: mocks.pref }));
vi.mock('../lib/boot', () => ({ keys: mocks.keys }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('window', {});
  mocks.pref.mockReturnValue(null);
  mocks.session.open.mockResolvedValue(mocks.info);
  mocks.session.reset.mockResolvedValue({ warnings: [] });
  mocks.session.close.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('SPA filesystem session binding', () => {
  it('defers browser storage and keys during server rendering', async () => {
    vi.stubGlobal('window', undefined);
    const filesystem = await import('../lib/filesystem');
    expect(await filesystem.initFileSystem()).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.keys).not.toHaveBeenCalled();
  });

  it('opens one broker-policy session with the chosen browser backend and publishes its bindings', async () => {
    const filesystem = await import('../lib/filesystem');
    const info = await filesystem.initFileSystem('indexeddb');
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({ policy: 'broker', keys: mocks.keys.mock.results[0].value, backend: 'indexeddb' });
    expect(info).toBe(mocks.info);
    expect(filesystem.fs).toBe(mocks.info.zfs);
    expect(filesystem.fsInfo).toBe(mocks.info);
    await filesystem.initFileSystem('opfs');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.session.open).toHaveBeenCalledTimes(2);
  });

  it('uses only persistent browser backend preferences when constructing the core session', async () => {
    mocks.pref.mockReturnValue('memory');
    const filesystem = await import('../lib/filesystem');
    await filesystem.initFileSystem();
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ policy: 'broker', backend: undefined });
  });

  it('returns core reset warnings and clears the app snapshot', async () => {
    const filesystem = await import('../lib/filesystem');
    await filesystem.initFileSystem();
    const result = { warnings: ['A failed write was discarded during reset'] };
    mocks.session.reset.mockResolvedValue(result);
    expect(await filesystem.resetFileSystem()).toBe(result);
    expect(mocks.session.reset).toHaveBeenCalledOnce();
    expect(mocks.session.close).not.toHaveBeenCalled();
    expect(filesystem.fsInfo).toBeNull();
  });

  it('routes standalone reset without opening storage and forwards deletion failures', async () => {
    const failure = new Error('Deletion failed');
    mocks.session.reset.mockRejectedValue(failure);
    const filesystem = await import('../lib/filesystem');
    await expect(filesystem.resetFileSystem()).rejects.toBe(failure);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.session.open).not.toHaveBeenCalled();
    expect(filesystem.fsInfo).toBeNull();
  });

  it('routes durability and close to core and clears bindings when close reports failure', async () => {
    const filesystem = await import('../lib/filesystem');
    await filesystem.flushFileSystem();
    expect(mocks.create).not.toHaveBeenCalled();
    await filesystem.initFileSystem();
    await filesystem.flushFileSystem();
    expect(mocks.session.flush).toHaveBeenCalledOnce();
    const failure = new Error('flush failed while closing');
    mocks.session.close.mockRejectedValue(failure);
    await expect(filesystem.closeFileSystem()).rejects.toBe(failure);
    expect(filesystem.fsInfo).toBeNull();
  });
});
