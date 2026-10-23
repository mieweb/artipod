import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStateMedium, UiStateIO } from '../lib/services/ui-state';

const bindings = vi.hoisted(() => ({
  keys: { flush: vi.fn() },
  registryFlush: vi.fn(),
  acknowledge: vi.fn(),
  uiState: vi.fn(),
  session: { open: vi.fn(), flush: vi.fn(), recover: vi.fn() },
}));

vi.mock('../lib/boot', () => ({ keys: () => bindings.keys, flushUiState: () => bindings.registryFlush(), acknowledgeUiStateRecovery: () => bindings.acknowledge(), uiState: () => bindings.uiState() }));
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

  it('awaits a renewal admitted during the final storage flush before its broker snapshot exists', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    const { KeysService, RENEW_TASK, nodeAdapters } = await import('@artipod/core/storage');
    const { Authority } = await import('@artipod/core/manager');
    const { createKeysHandler } = await import('@artipod/core/server');
    const { hostSave } = await import('../lib/services/host-save');
    const { initFileSystem, saveFileSystem } = await import('../lib/filesystem');
    const authority = await Authority.create('save-boundary-test');
    const podId = 'pod0000000000001';
    authority.registerPod(podId, new Uint8Array(32).fill(7));
    const handler = createKeysHandler({ authority, podIds: [podId], capTtlMs: 3600_000 });
    const adapters = nodeAdapters({ fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const request = new Request(`http://broker${path}`, init ?? (input instanceof Request ? input : undefined));
      return handler(request, path.split('/').filter(Boolean).slice(2));
    }) as typeof fetch });
    const service = new KeysService(adapters);
    const originalFetch = globalThis.fetch;
    let renewing = false;
    let principalReady!: () => void;
    const requestedPrincipal = new Promise<void>(resolve => { principalReady = resolve; });
    let finishPrincipal!: () => void;
    const principalGate = new Promise<void>(resolve => { finishPrincipal = resolve; });
    try {
      await service.install(async () => {
        if (renewing) { principalReady(); await principalGate; }
        return 'tester';
      });
      const grantWrite = vi.spyOn(adapters.kv, 'put');
      const io = new UiStateIO(memoryStateMedium());
      await io.recordWorkspace('private:_1', 'pod', 'rw');
      bindings.keys.flush.mockReset().mockImplementation(() => service.flush());
      bindings.registryFlush.mockImplementation(() => io.flush());
      bindings.session.open.mockResolvedValue({ zfs: {} });
      let brokerPublished = false;
      service.subscribe(() => {
        if (renewing && !brokerPublished && !service.getSnapshot().renewing) {
          brokerPublished = true;
          hostSave.schedule(async () => { await io.patch('private:_1', { encrypted: true }); }, 500, () => {});
        }
      });
      let renewal: Promise<void> | undefined;
      const saved: unknown[] = [];
      bindings.session.flush.mockImplementation(async () => {
        saved.push(await io.read());
        if (saved.length === 1) {
          renewing = true;
          renewal = service.scheduler.run(RENEW_TASK);
          await requestedPrincipal;
        }
      });
      await initFileSystem();
      let complete = false;
      const saving = saveFileSystem().then(() => { complete = true; });
      await requestedPrincipal;
      await vi.waitFor(() => expect(bindings.keys.flush).toHaveBeenCalledTimes(2));
      expect(complete).toBe(false);
      expect(brokerPublished).toBe(false);
      expect(grantWrite).not.toHaveBeenCalled();
      finishPrincipal();
      await Promise.all([saving, renewal]);
      expect(grantWrite).toHaveBeenCalledWith('session', expect.any(Object));
      expect(saved.at(-1)).toMatchObject({ workspaces: [{ id: 'private:_1', encrypted: true }] });
      expect(saved.length).toBeGreaterThan(1);
    } finally {
      finishPrincipal();
      service.scheduler.dispose();
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a lost registry field after an unrelated save and clears it only after retry or authenticated recovery', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {});
    const { initFileSystem, saveFileSystem, recoverFileSystem } = await import('../lib/filesystem');
    const medium = memoryStateMedium();
    const io = new UiStateIO(medium);
    await io.recordWorkspace('private:_1', 'pod', 'rw');
    await io.patch('private:_1', { unsynced: false });
    bindings.keys.flush.mockResolvedValue(undefined);
    bindings.registryFlush.mockImplementation(() => io.flush());
    bindings.acknowledge.mockImplementation(() => io.acknowledgeRecovery());
    bindings.session.open.mockResolvedValue({ zfs: {} });
    bindings.session.flush.mockReset().mockResolvedValue(undefined);
    await initFileSystem();
    const write = medium.write;
    const failure = new Error('EACCES: lease expired before writing the registry');
    medium.write = async () => { throw failure; };
    await expect(io.patch('private:_1', { unsynced: true })).rejects.toBe(failure);
    medium.write = write;
    await io.patch('private:_1', { hasChanges: true });
    expect((await io.read()).workspaces[0]).toMatchObject({ unsynced: false, hasChanges: true });
    await expect(saveFileSystem()).rejects.toBe(failure);
    expect(bindings.session.flush).not.toHaveBeenCalled();
    await io.patch('private:_1', { unsynced: true });
    await saveFileSystem();

    medium.write = async () => { throw failure; };
    await expect(io.patch('private:_1', { encrypted: true })).rejects.toBe(failure);
    medium.write = write;
    bindings.acknowledge.mockClear();
    bindings.session.recover.mockRejectedValueOnce(new Error('Saved generation did not authenticate'));
    await expect(recoverFileSystem()).rejects.toThrow('did not authenticate');
    expect(bindings.acknowledge).not.toHaveBeenCalled();
    await expect(saveFileSystem()).rejects.toBe(failure);
    bindings.session.recover.mockResolvedValue({ info: { zfs: {} }, warning: 'Some changes could not be saved' });
    expect((await recoverFileSystem()).warning).toContain('could not be saved');
    expect(bindings.acknowledge).toHaveBeenCalledOnce();
    await saveFileSystem();
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

  it('awaits server verdict refresh while preserving unsynced metadata for push acknowledgement', async () => {
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
    expect(durable).toMatchObject({ workspaces: [{ id: 'private:_1', unsynced: true }] });
    expect(catalogStore.getState().verdicts).toEqual({ 'private:_1': 'synced' });
  });
});
