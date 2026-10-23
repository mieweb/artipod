import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const sandbox = { exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })), dispose: vi.fn() };
  const pod = {
    basis: { at: '/open/private', ref: 'private:_1' },
    zfs: { promises: {} }, keyring: { revokeAll: vi.fn() }, dispose: vi.fn(),
    createSandbox: vi.fn(() => sandbox), pushBasis: vi.fn<() => Promise<null>>(),
    processes: { spawn: vi.fn(() => ({ update: vi.fn(), exit: vi.fn() })) },
  };
  const fs = { promises: { readdir: vi.fn(async () => ['unsynced.txt']) } };
  const info = { zfs: fs, backend: 'memory', encrypted: false };
  const storage = { open: vi.fn(async () => info), flush: vi.fn(async () => {}), openWorkspaceUpper: vi.fn(async () => ({})) };
  const state: { service: unknown; io: unknown; offline: boolean } = { service: undefined, io: undefined, offline: false };
  return { sandbox, pod, fs, info, storage, state, createPod: vi.fn(async () => pod), runtime: { dispose: vi.fn(), stop: vi.fn() } };
});

vi.mock('../lib/boot', () => ({
  actorId: async () => 'actor', keys: () => mocks.state.service,
  uiState: async () => ({ io: mocks.state.io }),
  flushUiState: async () => { await (mocks.state.io as { flush(): Promise<void> }).flush(); },
  workspaceUrl: () => '/', nextDraftRef: () => 'draft',
}));
vi.mock('../lib/services/inventory', () => ({ catalogInventory: () => ({}) }));
vi.mock('@artipod/core', () => ({ createZenFsPod: mocks.createPod }));
vi.mock('@artipod/core/storage', async importOriginal => ({
  ...await importOriginal<typeof import('@artipod/core/storage')>(),
  createStorageSession: () => mocks.storage,
}));
vi.mock('@artipod/core/oci', () => ({
  ArtipodRegistryProxyTransport: class {},
  readPodSettings: async () => ({ offline: mocks.state.offline }),
}));
vi.mock('@artipod/core/manager', () => ({ HttpPodStore: class {} }));
vi.mock('@artipod/core/apps', () => ({ createBrowserRuntime: () => mocks.runtime }));
vi.mock('@artipod/core/sandbox', () => ({ setAuthPrompt: vi.fn(), loadBackendPref: () => 'opfs' }));
vi.mock('just-bash/browser', () => ({ defineCommand: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.pod.pushBasis.mockReset();
  mocks.storage.flush.mockResolvedValue(undefined);
  mocks.fs.promises.readdir.mockReset().mockResolvedValue(['unsynced.txt']);
  mocks.state.offline = false;
  vi.stubGlobal('navigator', { locks: { request: vi.fn((_name: string, _options: unknown, callback: () => Promise<void>) => callback()) } });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), history: { replaceState: vi.fn() } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function failingWorkspace() {
  const { TaskScheduler } = await import('@artipod/core/storage');
  const { UiStateIO, memoryStateMedium } = await import('../lib/services/ui-state');
  const medium = memoryStateMedium();
  const io = new UiStateIO(medium);
  const service = {
    scheduler: new TaskScheduler(), forcedOffline: false,
    getKey: () => null, getLease: () => null, flush: async () => {},
    reconcileOffline(value: boolean) { service.forcedOffline = value; },
  };
  mocks.state.service = service;
  mocks.state.io = io;
  const { openPodSession } = await import('../lib/services/pod-session');
  const { saveFileSystem } = await import('../lib/filesystem');
  const opening = openPodSession({ id: 'private:_1', isRef: true, mode: 'rw' });
  const session = await opening;
  mocks.pod.pushBasis.mockImplementation(async () => {
    // Bound a regressing retry loop deterministically instead of hanging the
    // test runner; every production-shaped remote attempt otherwise fails.
    if (mocks.pod.pushBasis.mock.calls.length > 4) throw new Error('Save entered an immediate remote retry loop');
    session.events.emit('sync:push', { ref: 'private:_1', ok: false, layers: 0, movedBytes: 0, error: 'Remote stays unavailable' });
    return null;
  });
  return { opening, session, io, medium, service, saveFileSystem };
}

describe('workspace save with a persistently unavailable remote', () => {
  it('finishes local save with unsynced metadata and leaves retries on the existing interval', async () => {
    const { opening, session, io, service, saveFileSystem } = await failingWorkspace();
    let durable: unknown;
    mocks.storage.flush.mockImplementation(async () => { durable = await io.read(); });
    try {
      session.events.emit('fs:changed', { origin: 'editor' });
      await saveFileSystem();
      expect(mocks.pod.pushBasis).toHaveBeenCalledOnce();
      expect(durable).toMatchObject({ workspaces: [{ id: 'private:_1', hasChanges: true, unsynced: true }] });
      expect(service.scheduler.list().find(task => task.name === 'sync:push')?.state).toBe('scheduled');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mocks.pod.pushBasis).toHaveBeenCalledTimes(2);
      await saveFileSystem();
      expect(mocks.pod.pushBasis).toHaveBeenCalledTimes(2);
      expect((await io.read()).workspaces[0].unsynced).toBe(true);
    } finally { service.forcedOffline = true; await opening.close(); service.scheduler.dispose(); }
  });

  it('retries once for a real offline-to-online transition and does not retry subsequent online probes', async () => {
    const { opening, session, io, service, saveFileSystem } = await failingWorkspace();
    try {
      await session.pod.pushBasis();
      await saveFileSystem();
      expect(mocks.pod.pushBasis).toHaveBeenCalledOnce();
      mocks.state.offline = true;
      session.events.emit('sync:push', { ref: 'private:_1', ok: false, layers: 0, movedBytes: 0, error: 'Offline' });
      await saveFileSystem();
      expect(service.forcedOffline).toBe(true);
      expect(mocks.pod.pushBasis).toHaveBeenCalledOnce();
      mocks.state.offline = false;
      // The service may have already adopted the toggle before its probe;
      // compare against the state machine's last observed offline state.
      service.forcedOffline = false;
      session.events.emit('sync:push', { ref: 'private:_1', ok: false, layers: 0, movedBytes: 0, error: 'Remote stays unavailable' });
      await saveFileSystem();
      expect(mocks.pod.pushBasis).toHaveBeenCalledTimes(2);
      await saveFileSystem();
      expect(mocks.pod.pushBasis).toHaveBeenCalledTimes(2);
      expect((await io.read()).workspaces[0].unsynced).toBe(true);
    } finally { service.forcedOffline = true; await opening.close(); service.scheduler.dispose(); }
  });

  it('serializes a held old probe before a probe admitted by a newer edit', async () => {
    const { opening, session, io, service, saveFileSystem } = await failingWorkspace();
    mocks.pod.pushBasis.mockResolvedValue(null);
    let readStarted!: () => void;
    const reading = new Promise<void>(resolve => { readStarted = resolve; });
    let finishRead!: () => void;
    const gate = new Promise<void>(resolve => { finishRead = resolve; });
    mocks.fs.promises.readdir.mockImplementationOnce(async () => { readStarted(); await gate; return []; });
    let durable: unknown;
    mocks.storage.flush.mockImplementation(async () => { durable = await io.read(); });
    try {
      await vi.advanceTimersByTimeAsync(500);
      await reading;
      session.events.emit('fs:changed', { origin: 'editor' });
      await vi.advanceTimersByTimeAsync(500);
      expect(mocks.fs.promises.readdir).toHaveBeenCalledOnce();
      const saving = saveFileSystem();
      finishRead();
      await saving;
      expect(mocks.fs.promises.readdir).toHaveBeenCalledTimes(2);
      expect(durable).toMatchObject({ workspaces: [{ id: 'private:_1', hasChanges: true }] });
    } finally { finishRead(); service.forcedOffline = true; await opening.close(); service.scheduler.dispose(); }
  });

  it('reports a failed probe write and permits a later successful probe retry', async () => {
    const { opening, session, io, medium, service, saveFileSystem } = await failingWorkspace();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const write = medium.write;
    const failure = new Error('The probe could not save its registry flag');
    try {
      medium.write = async () => { throw failure; };
      await expect(saveFileSystem()).rejects.toBe(failure);
      expect(errors).toHaveBeenCalledWith('workspace persistence failed:', failure);
      medium.write = write;
      session.events.emit('sync:push', { ref: 'private:_1', ok: false, layers: 0, movedBytes: 0, error: 'Remote stays unavailable' });
      await saveFileSystem();
      expect((await io.read()).workspaces[0]).toMatchObject({ hasChanges: true, unsynced: true });
    } finally { medium.write = write; service.forcedOffline = true; await opening.close(); service.scheduler.dispose(); errors.mockRestore(); }
  });
});
