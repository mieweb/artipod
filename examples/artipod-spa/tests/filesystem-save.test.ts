import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStateMedium, UiStateIO } from '../lib/services/ui-state';

const bindings = vi.hoisted(() => ({
  keys: { flush: vi.fn() },
  registryFlush: vi.fn(),
  uiState: vi.fn(),
  session: { open: vi.fn(), flush: vi.fn() },
}));

vi.mock('../lib/boot', () => ({ keys: () => bindings.keys, flushUiState: () => bindings.registryFlush(), uiState: () => bindings.uiState() }));
vi.mock('../lib/services/catalog-service', () => ({
  boundAncestry: async () => async () => true,
  computeVerdicts: async () => new Map([['private:_1', 'synced']]),
  healUnsynced: (entries: Array<{ id: string; unsynced?: boolean }>) => entries.filter(entry => entry.unsynced).map(entry => entry.id),
}));
vi.mock('@artipod/core/storage', async importOriginal => ({
  ...await importOriginal<typeof import('@artipod/core/storage')>(),
  createStorageSession: () => bindings.session,
}));
vi.mock('@artipod/core/sandbox', () => ({ loadBackendPref: () => 'opfs' }));

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('saveFileSystem production composition', () => {
  it('awaits a delayed preference, queued registry probe and metadata admitted by the first flush', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    const { hostSave } = await import('../lib/services/host-save');
    const { initFileSystem, saveFileSystem } = await import('../lib/filesystem');
    const io = new UiStateIO(memoryStateMedium());
    const info = { zfs: {}, encrypted: true };
    bindings.session.open.mockResolvedValue(info);
    bindings.registryFlush.mockImplementation(() => io.flush());
    let finishPreference!: () => void;
    const preference = new Promise<void>(resolve => { finishPreference = resolve; });
    let offline = false;
    bindings.keys.flush.mockImplementation(async () => { await preference; offline = true; });
    const saved: Array<{ offline: boolean; registry: unknown }> = [];
    bindings.session.flush.mockImplementation(async () => {
      saved.push({ offline, registry: await io.read() });
      if (saved.length === 1) hostSave.schedule(async () => { await io.patch('private:_1', { encrypted: true }); }, 500, () => {});
    });
    await initFileSystem();
    hostSave.schedule(async () => {
      await io.recordWorkspace('private:_1', 'pod', 'cow');
      await io.patch('private:_1', { hasChanges: true, unsynced: true });
    }, 500, () => {});
    let complete = false;
    const saving = saveFileSystem().then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(saved).toHaveLength(0);
    finishPreference();
    await saving;
    expect(saved.at(-1)).toMatchObject({ offline: true, registry: { workspaces: [{ id: 'private:_1', encrypted: true, hasChanges: true, unsynced: true }] } });
    expect(vi.getTimerCount()).toBe(0);
    expect((window as unknown as { __artipodSave: unknown }).__artipodSave).toBe(saveFileSystem);
  });

  it('rejects service persistence errors before reporting a completed filesystem save', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    const { initFileSystem, saveFileSystem } = await import('../lib/filesystem');
    const failure = new Error('Settings could not persist');
    bindings.session.open.mockResolvedValue({ zfs: {} });
    bindings.session.flush.mockClear();
    bindings.keys.flush.mockRejectedValue(failure);
    await initFileSystem();
    await expect(saveFileSystem()).rejects.toBe(failure);
    expect(bindings.session.flush).not.toHaveBeenCalled();
  });

  it.each(['scheduled', 'inflight'])('awaits a held %s automatic push before saving its registry outcome', async phase => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('window', {});
    const { PodEvents } = await import('@artipod/core/host');
    const { workspaceAutoPush } = await import('../lib/services/workspace-auto-push');
    const { initFileSystem, saveFileSystem } = await import('../lib/filesystem');
    const io = new UiStateIO(memoryStateMedium());
    await io.recordWorkspace('private:_1', 'pod', 'rw');
    await io.patch('private:_1', { unsynced: true });
    bindings.keys.flush.mockResolvedValue(undefined);
    bindings.registryFlush.mockImplementation(() => io.flush());
    bindings.session.open.mockResolvedValue({ zfs: {} });
    let durable: unknown;
    bindings.session.flush.mockImplementation(async () => { durable = await io.read(); });
    await initFileSystem();
    const events = new PodEvents();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const push = vi.fn(async () => { ready(); await gate; await io.patch('private:_1', { unsynced: false }); });
    const dispose = workspaceAutoPush({ events, push, enabled: () => true, onError: error => { throw error; } });
    events.emit('fs:changed', { origin: 'editor' });
    if (phase === 'inflight') await vi.advanceTimersByTimeAsync(2000);
    let complete = false;
    const saving = saveFileSystem().then(() => { complete = true; });
    await started;
    expect(complete).toBe(false);
    expect(durable).toBeUndefined();
    finish();
    await saving;
    expect(durable).toMatchObject({ workspaces: [{ id: 'private:_1', unsynced: false }] });
    expect(push).toHaveBeenCalledOnce();
    dispose();
  });

  it('awaits server refresh through inline verdict healing without a React effect', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    const { initFileSystem, saveFileSystem } = await import('../lib/filesystem');
    const { catalogStore, refreshServer } = await import('../lib/stores/catalog');
    const { registryStore } = await import('../lib/stores/registry');
    const io = new UiStateIO(memoryStateMedium());
    await io.recordWorkspace('private:_1', 'pod', 'rw');
    await io.patch('private:_1', { unsynced: true });
    registryStore.setState({ entries: (await io.read()).workspaces });
    catalogStore.setState({ localHeads: { 'private:_1': 'sha256:saved' } });
    bindings.keys.flush.mockResolvedValue(undefined);
    bindings.uiState.mockResolvedValue({ io });
    bindings.registryFlush.mockImplementation(() => io.flush());
    bindings.session.open.mockResolvedValue({ zfs: {} });
    let durable: unknown;
    bindings.session.flush.mockImplementation(async () => { durable = await io.read(); });
    await initFileSystem();
    let ready!: () => void;
    const requested = new Promise<void>(resolve => { ready = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const refreshing = refreshServer((async () => {
      ready(); await gate;
      return Response.json([{ ref: 'private:_1', manifestDigest: 'sha256:saved' }]);
    }) as typeof fetch);
    await requested;
    let complete = false;
    const saving = saveFileSystem().then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    finish();
    await Promise.all([refreshing, saving]);
    expect(durable).toMatchObject({ workspaces: [{ id: 'private:_1', unsynced: false }] });
  });
});
