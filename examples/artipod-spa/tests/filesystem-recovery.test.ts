import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageSessionSnapshot } from '@artipod/core/storage';

const mocks = vi.hoisted(() => {
  class PersistenceError extends Error {}
  const initial = { zfs: { promises: {} }, encrypted: true };
  const reopened = { zfs: { promises: {} }, encrypted: true };
  const teardown = vi.fn(async () => {});
  let snapshot: StorageSessionSnapshot = { status: 'closed', needsRecovery: false };
  const listeners = new Set<() => void>();
  const publish = (value: StorageSessionSnapshot) => { snapshot = value; for (const listener of listeners) listener(); };
  const session = {
    open: vi.fn(async () => initial), needsRecovery: vi.fn(() => false),
    recover: vi.fn(async () => ({ info: reopened, warning: 'Some changes could not be saved' })),
    registerTeardown: vi.fn(() => teardown), openWorkspaceUpper: vi.fn(),
    getSnapshot: vi.fn(() => snapshot),
    subscribe: vi.fn((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }),
  };
  return { PersistenceError, initial, reopened, session, teardown, publish, listeners, acknowledge: vi.fn(async () => {}), create: vi.fn(() => session) };
});
vi.mock('@artipod/core/storage', () => ({ createStorageSession: mocks.create, StorageClosePersistenceError: mocks.PersistenceError }));
vi.mock('@artipod/core/sandbox', () => ({ loadBackendPref: () => null }));
vi.mock('../lib/boot', () => ({ keys: () => ({}), acknowledgeUiStateRecovery: mocks.acknowledge }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('window', {});
  mocks.session.open.mockResolvedValue(mocks.initial);
  mocks.session.recover.mockResolvedValue({ info: mocks.reopened, warning: 'Some changes could not be saved' });
  mocks.session.needsRecovery.mockReturnValue(false);
  mocks.listeners.clear();
  mocks.publish({ status: 'closed', needsRecovery: false });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('SPA recovery bridge to the core storage session', () => {
  it('observes post-boot write failure and recovery without a broker change or storage reinitialization', async () => {
    const filesystem = await import('../lib/filesystem');
    const observed: StorageSessionSnapshot[] = [];
    const off = filesystem.subscribeFileSystem(() => observed.push(filesystem.getFileSystemSnapshot()));
    const beforeOpen = filesystem.getFileSystemSnapshot();
    expect(filesystem.getFileSystemSnapshot()).toBe(beforeOpen);
    expect(filesystem.getServerFileSystemSnapshot()).toBe(beforeOpen);
    expect(mocks.create).not.toHaveBeenCalled();
    await filesystem.initFileSystem('indexeddb');
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0]).toEqual([{ policy: 'broker', keys: {}, backend: 'indexeddb' }]);
    mocks.publish({ status: 'open', needsRecovery: false, protection: 'encrypted' });
    mocks.publish({ status: 'failed', needsRecovery: true, protection: 'encrypted' });
    expect(observed.at(-1)).toEqual({ status: 'failed', needsRecovery: true, protection: 'encrypted' });
    expect(mocks.session.open).toHaveBeenCalledOnce();
    mocks.session.recover.mockImplementationOnce(async () => {
      mocks.publish({ status: 'recovering', needsRecovery: true, protection: 'encrypted' });
      mocks.publish({ status: 'open', needsRecovery: false, protection: 'encrypted' });
      return { info: mocks.reopened, warning: 'Some changes could not be saved' };
    });
    await filesystem.recoverFileSystem();
    expect(mocks.acknowledge).toHaveBeenCalledOnce();
    expect(observed.map(snapshot => snapshot.status)).toEqual(['open', 'failed', 'recovering', 'open']);
    expect(filesystem.getFileSystemSnapshot().needsRecovery).toBe(false);
    expect(filesystem.fs).toBe(mocks.reopened.zfs);
    off();
    mocks.publish({ status: 'failed', needsRecovery: true });
    expect(observed).toHaveLength(4);
  });

  it('reports core recovery state and registers consumer teardown on the same session', async () => {
    const filesystem = await import('../lib/filesystem');
    expect(filesystem.fileSystemNeedsRecovery()).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    const close = vi.fn(async () => {});
    expect(filesystem.registerFileSystemTeardown(close, 'Workspace session')).toBe(mocks.teardown);
    expect(mocks.session.registerTeardown).toHaveBeenCalledExactlyOnceWith(close, 'Workspace session');
    mocks.session.needsRecovery.mockReturnValue(true);
    expect(filesystem.fileSystemNeedsRecovery()).toBe(true);
    expect(filesystem.FileSystemClosePersistenceError).toBe(mocks.PersistenceError);
  });

  it('publishes the recovered filesystem and preserves the core warning', async () => {
    const filesystem = await import('../lib/filesystem');
    await filesystem.initFileSystem();
    const result = await filesystem.recoverFileSystem();
    expect(mocks.session.recover).toHaveBeenCalledOnce();
    expect(result).toEqual({ info: mocks.reopened, warning: 'Some changes could not be saved' });
    expect(filesystem.fs).toBe(mocks.reopened.zfs);
    expect(filesystem.fsInfo).toBe(mocks.reopened);
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('forwards authenticated recovery failures without replacing the existing app binding', async () => {
    const filesystem = await import('../lib/filesystem');
    await filesystem.initFileSystem();
    const failure = new Error('Key does not authenticate saved ciphertext');
    mocks.session.recover.mockRejectedValue(failure);
    await expect(filesystem.recoverFileSystem()).rejects.toBe(failure);
    expect(filesystem.fs).toBe(mocks.initial.zfs);
    expect(filesystem.fsInfo).toBe(mocks.initial);
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it('routes workspace upper requests to the owning core session', async () => {
    const upper = { name: 'protected upper' };
    mocks.session.openWorkspaceUpper.mockResolvedValue(upper);
    const filesystem = await import('../lib/filesystem');
    expect(await filesystem.openFileSystemWorkspaceUpper('private-workspace:1')).toBe(upper);
    expect(mocks.session.openWorkspaceUpper).toHaveBeenCalledExactlyOnceWith('private-workspace:1');
    expect(mocks.create).toHaveBeenCalledOnce();
  });
});
