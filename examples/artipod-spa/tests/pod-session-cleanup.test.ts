import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class PersistenceError extends Error {}
  const sandbox = { exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })), dispose: vi.fn() };
  const scheduler = { cancel: vi.fn(), register: vi.fn(), run: vi.fn(async () => {}), onChange: vi.fn(() => vi.fn()), list: () => [], schedule: vi.fn() };
  const runtime = { dispose: vi.fn(), stop: vi.fn() };
  const pod = {
    zfs: { promises: {} }, keyring: { revokeAll: vi.fn() }, dispose: vi.fn(),
    createSandbox: vi.fn(() => sandbox), pushBasis: vi.fn(async () => null),
    processes: { spawn: vi.fn(() => ({ update: vi.fn(), exit: vi.fn() })) },
  };
  const io = { recordWorkspace: vi.fn(async () => {}), actorId: vi.fn(async () => 'actor'), patch: vi.fn(async () => {}), read: vi.fn(async () => ({ workspaces: [] })) };
  const fs = { promises: { mkdir: vi.fn(async () => {}) } };
  return { PersistenceError, sandbox, scheduler, runtime, pod, io, fs, createPod: vi.fn(async () => pod), flush: vi.fn(async () => {}) };
});

vi.mock('../lib/boot', () => ({
  actorId: async () => 'actor', keys: () => ({ scheduler: mocks.scheduler, getKey: () => null, getLease: () => null, forcedOffline: true }),
  uiState: async () => ({ io: mocks.io }), workspaceUrl: () => '/', nextDraftRef: () => 'draft',
}));
vi.mock('../lib/filesystem', () => ({
  FileSystemClosePersistenceError: mocks.PersistenceError, fs: mocks.fs,
  initFileSystem: async () => ({ backend: 'memory', encrypted: false }), flushFileSystem: mocks.flush,
}));
vi.mock('../lib/services/workspace-storage', () => ({ openWorkspaceUpper: vi.fn() }));
vi.mock('../lib/services/inventory', () => ({ catalogInventory: () => ({}) }));
vi.mock('@artipod/core', () => ({ createZenFsPod: mocks.createPod }));
vi.mock('@artipod/core/oci', () => ({ ArtipodRegistryProxyTransport: class {} }));
vi.mock('@artipod/core/manager', () => ({ HttpPodStore: class {} }));
vi.mock('@artipod/core/host', () => ({ PodEvents: class { on() { return vi.fn(); } } }));
vi.mock('@artipod/core/apps', () => ({ createBrowserRuntime: () => mocks.runtime }));
vi.mock('@artipod/core/sandbox', () => ({ setAuthPrompt: vi.fn() }));
vi.mock('just-bash/browser', () => ({ defineCommand: vi.fn() }));

let lockReleased = vi.fn(() => {});
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  lockReleased = vi.fn();
  vi.stubGlobal('navigator', { locks: { request: vi.fn((_name: string, _options: unknown, callback: () => Promise<void>) => {
    return callback().then(() => { lockReleased(); });
  }) } });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), history: { replaceState: vi.fn() } });
  mocks.io.patch.mockResolvedValue();
  mocks.runtime.dispose.mockReset();
  mocks.flush.mockResolvedValue();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const route = (id: string) => ({ id, isRef: false, mode: 'rw' as const });

describe('pod session verified disposal', () => {
  it('disposes pod and sandbox when boot fails after creation, then permits a clean replacement', async () => {
    const failure = new Error('registry unavailable');
    mocks.io.patch.mockRejectedValueOnce(failure);
    const { openPodSession } = await import('../lib/services/pod-session');
    await expect(openPodSession(route('failed'))).rejects.toBe(failure);
    expect(mocks.sandbox.dispose).toHaveBeenCalledOnce();
    expect(mocks.pod.keyring.revokeAll).toHaveBeenCalledOnce();
    expect(mocks.pod.dispose).toHaveBeenCalledOnce();
    expect(lockReleased).toHaveBeenCalledOnce();
    const fresh = openPodSession(route('fresh'));
    await fresh;
    await fresh.close();
    expect(mocks.pod.dispose).toHaveBeenCalledTimes(2);
  });

  it('immediately releases a workspace lock acquired after failed boot cleanup', async () => {
    let acquire!: () => Promise<void>;
    vi.mocked(navigator.locks.request).mockImplementation((_name, _options, callback) => {
      acquire = callback as unknown as () => Promise<void>;
      return Promise.resolve();
    });
    mocks.io.patch.mockRejectedValueOnce(new Error('registry unavailable'));
    const { openPodSession } = await import('../lib/services/pod-session');
    await expect(openPodSession(route('failed'))).rejects.toThrow('registry unavailable');
    await expect(acquire()).resolves.toBeUndefined();
  });

  it('still disposes pod/providers after runtime disposal fails and blocks subsequent boot', async () => {
    const { openPodSession } = await import('../lib/services/pod-session');
    const old = openPodSession(route('old'));
    await old;
    mocks.runtime.dispose.mockImplementation(() => { throw new Error('runtime disposal failed'); });
    await expect(old.close()).rejects.toThrow('Workspace disposal failed');
    expect(mocks.sandbox.dispose).toHaveBeenCalledOnce();
    expect(mocks.pod.dispose).toHaveBeenCalledOnce();
    expect(window.removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
    await expect(openPodSession(route('fresh'))).rejects.toThrow('Workspace disposal failed');
    expect(mocks.createPod).toHaveBeenCalledOnce();
  });

  it('permits replacement after a flush-only failure once all disposal completes', async () => {
    const { openPodSession } = await import('../lib/services/pod-session');
    const old = openPodSession(route('old'));
    await old;
    mocks.flush.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(old.close()).rejects.toBeInstanceOf(mocks.PersistenceError);
    expect(mocks.sandbox.dispose).toHaveBeenCalledOnce();
    expect(mocks.pod.dispose).toHaveBeenCalledOnce();
    const fresh = openPodSession(route('fresh'));
    await fresh;
    await fresh.close();
    expect(mocks.createPod).toHaveBeenCalledTimes(2);
  });
});
