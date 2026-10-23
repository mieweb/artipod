import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStateMedium, UiStateIO } from '../lib/services/ui-state';

const bindings = vi.hoisted(() => ({
  uiState: vi.fn(),
  ancestry: vi.fn(),
  localRefs: vi.fn(async () => [{ ref: 'private:_1', manifestDigest: 'sha256:local' }]),
  patch: vi.fn(),
  fs: { promises: {
    readdir: vi.fn(async (_path: string): Promise<string[]> => []), exists: vi.fn(async () => false),
    rmdir: vi.fn(async () => {}), rm: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ isDirectory: () => false, mtimeMs: 1000 })),
  } },
}));

vi.mock('../lib/boot', () => ({ uiState: () => bindings.uiState(), keys: () => ({ getKey: () => null, reconcileOffline: () => {} }) }));
vi.mock('../lib/filesystem', () => ({ initFileSystem: async () => ({}), fs: bindings.fs }));
vi.mock('../lib/services/catalog-service', () => ({
  boundAncestry: () => bindings.ancestry(),
  computeVerdicts: async () => new Map([['private:_1', 'synced']]),
}));
vi.mock('@artipod/core/oci', () => ({
  readPodSettings: async () => ({ offline: false }),
  OciStore: class {
    async init() {}
    async listRefs() { return bindings.localRefs(); }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  bindings.localRefs.mockResolvedValue([{ ref: 'private:_1', manifestDigest: 'sha256:local' }]);
  bindings.fs.promises.readdir.mockResolvedValue([]);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('catalog refresh save ownership', () => {
  it.each(['initial', 'debounced'] as const)('drains a disposed %s scan without retaining its late lock failure', async phase => {
    const { createCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { hostSave } = await import('../lib/services/host-save');
    const reading = deferred<void>();
    const registry = deferred<{ workspaces: [] }>();
    bindings.uiState.mockResolvedValue({ io: { read: () => { reading.resolve(); return registry.promise; } }, registry: {} });
    const refresh = createCatalogRefresh();
    const onError = vi.fn();
    const initial = phase === 'initial' ? refresh.refresh().catch(error => error) : undefined;
    if (phase === 'debounced') {
      refresh.schedule(300, onError);
      await vi.advanceTimersByTimeAsync(300);
    }
    await reading.promise;
    refresh.dispose();
    let saved = false;
    const saving = hostSave.save(async () => {}).then(() => { saved = true; });
    await Promise.resolve();
    expect(saved).toBe(false);
    const failure = new Error('The previous catalog root is locked');
    registry.reject(failure);
    if (initial) expect(await initial).toBe(failure);
    await saving;
    expect(saved).toBe(true);
    if (phase === 'debounced') expect(onError).toHaveBeenCalledWith(failure);
  });

  it.each(['initial', 'debounced'] as const)('keeps a live %s scan failure visible until its owner is disposed', async phase => {
    const { createCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { hostSave } = await import('../lib/services/host-save');
    const failure = new Error('The active catalog scan could not read the registry');
    bindings.uiState.mockResolvedValue({ io: { read: async () => { throw failure; } }, registry: {} });
    const refresh = createCatalogRefresh();
    if (phase === 'initial') await expect(refresh.refresh()).rejects.toBe(failure);
    else {
      const onError = vi.fn();
      refresh.schedule(300, onError);
      await vi.advanceTimersByTimeAsync(300);
      expect(onError).toHaveBeenCalledWith(failure);
    }
    await expect(hostSave.save(async () => {})).rejects.toBe(failure);
    refresh.dispose();
    await hostSave.save(async () => {});
  });

  it('cancels queued rescans and refuses new scans after disposal', async () => {
    const { createCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { hostSave } = await import('../lib/services/host-save');
    const refresh = createCatalogRefresh();
    refresh.schedule(300, vi.fn());
    refresh.dispose();
    await refresh.refresh();
    refresh.schedule(300, vi.fn());
    await vi.runAllTimersAsync();
    await hostSave.save(async () => {});
    expect(bindings.uiState).not.toHaveBeenCalled();
  });

  it('drains accepted verdict work while skipping view publication after disposal', async () => {
    const { createCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { hostSave } = await import('../lib/services/host-save');
    const { catalogStore } = await import('../lib/stores/catalog');
    const verdictStarted = deferred<void>();
    const verdict = deferred<void>();
    bindings.uiState.mockResolvedValue({ io: { read: async () => ({ workspaces: [] }), drop: async () => {}, patch: bindings.patch }, registry: {} });
    bindings.patch.mockResolvedValue(undefined);
    bindings.ancestry.mockImplementation(async () => { verdictStarted.resolve(); await verdict.promise; return async () => true; });
    vi.stubGlobal('fetch', async () => Response.json([]));
    catalogStore.setState({ serverRefs: [{ ref: 'private:_1', manifestDigest: 'sha256:remote' }] });
    const refresh = createCatalogRefresh();
    const scanning = refresh.refresh();
    await verdictStarted.promise;
    const flush = vi.fn(async () => {});
    const saving = hostSave.save(flush);
    refresh.dispose();
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();
    verdict.resolve();
    await Promise.all([scanning, saving]);
    expect(bindings.patch).not.toHaveBeenCalled();
    expect(catalogStore.getState().verdicts).toEqual({});
    expect(flush).toHaveBeenCalled();
  });

  it('keeps durable hasChanges state when a scan observes an empty cached upper', async () => {
    const { createCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { catalogStore } = await import('../lib/stores/catalog');
    const io = new UiStateIO(memoryStateMedium());
    await io.recordWorkspace('private:_1', 'pod', 'cow');
    await io.patch('private:_1', { hasChanges: true });
    bindings.uiState.mockResolvedValue({ io, registry: {} });
    vi.stubGlobal('fetch', async () => Response.json([]));
    const refresh = createCatalogRefresh();
    await refresh.refresh();
    expect(catalogStore.getState().changedRefs).toEqual([]);
    expect((await io.read()).workspaces[0].hasChanges).toBe(true);
  });

  it.each(['disposed', 'superseded'] as const)('does not sweep an empty directory after its scan is %s during the listing', async phase => {
    const { createCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const io = new UiStateIO(memoryStateMedium());
    await io.recordWorkspace('empty', 'blank', 'rw');
    const drop = vi.spyOn(io, 'drop');
    bindings.uiState.mockResolvedValue({ io, registry: {} });
    const listing = deferred<void>();
    const entries = deferred<string[]>();
    let scans = 0;
    bindings.fs.promises.readdir.mockImplementation(async path => {
      if (path === '/work') return ++scans === 1 ? ['empty'] : [];
      listing.resolve();
      return entries.promise;
    });
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [] }) } });
    vi.stubGlobal('fetch', async () => Response.json([]));
    const refresh = createCatalogRefresh();
    const older = refresh.refresh();
    await listing.promise;
    if (phase === 'disposed') refresh.dispose();
    else await refresh.refresh();
    entries.resolve([]);
    await older;
    expect(bindings.fs.promises.rmdir).not.toHaveBeenCalled();
    expect(drop).not.toHaveBeenCalled();
    expect((await io.read()).workspaces[0].id).toBe('empty');
  });

  it('prevents an older overlapping scan from publishing local heads over a completed newer scan', async () => {
    const { createCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { catalogStore } = await import('../lib/stores/catalog');
    const io = new UiStateIO(memoryStateMedium());
    bindings.uiState.mockResolvedValue({ io, registry: {} });
    const listing = deferred<void>();
    const oldHeads = deferred<Array<{ ref: string; manifestDigest: string }>>();
    bindings.localRefs.mockImplementationOnce(async () => { listing.resolve(); return oldHeads.promise; });
    bindings.localRefs.mockResolvedValue([{ ref: 'private:_1', manifestDigest: 'sha256:newer' }]);
    vi.stubGlobal('fetch', async () => Response.json([]));
    const refresh = createCatalogRefresh();
    const older = refresh.refresh();
    await listing.promise;
    await refresh.refresh();
    oldHeads.resolve([{ ref: 'private:_1', manifestDigest: 'sha256:older' }]);
    await older;
    expect(catalogStore.getState().localHeads['private:_1']).toBe('sha256:newer');
  });

  it('filters a published blank from the view while preserving its nonempty workspace and registry', async () => {
    const { createCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { registryStore } = await import('../lib/stores/registry');
    const io = new UiStateIO(memoryStateMedium());
    await io.recordWorkspace('published', 'blank', 'rw');
    bindings.uiState.mockResolvedValue({ io, registry: {} });
    bindings.fs.promises.readdir.mockImplementation(async path => path === '/work' ? ['published'] : ['file.txt']);
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [] }) } });
    vi.stubGlobal('fetch', async (path: string) => Response.json(path === '/api/pods/refs'
      ? [{ manifestDigest: 'sha256:published' }]
      : { layers: [{ annotations: { 'org.artipod.path': '/file.txt', 'org.artipod.mtime': '1000' } }] }));
    await createCatalogRefresh().refresh();
    expect(registryStore.getState().entries).toEqual([]);
    expect((await io.read()).workspaces[0].id).toBe('published');
    expect(bindings.fs.promises.rm).not.toHaveBeenCalled();
    expect(bindings.fs.promises.rmdir).not.toHaveBeenCalled();
  });

  it('hides an empty inactive blank while retaining its directory and registry entry', async () => {
    const { createCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { registryStore } = await import('../lib/stores/registry');
    const io = new UiStateIO(memoryStateMedium());
    await io.recordWorkspace('empty', 'blank', 'rw');
    const drop = vi.spyOn(io, 'drop');
    const patch = vi.spyOn(io, 'patch');
    bindings.uiState.mockResolvedValue({ io, registry: {} });
    bindings.fs.promises.readdir.mockImplementation(async path => path === '/work' ? ['empty'] : []);
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [] }) } });
    vi.stubGlobal('fetch', async () => Response.json([]));
    await createCatalogRefresh().refresh();
    expect(registryStore.getState().entries).toEqual([]);
    expect((await io.read()).workspaces[0].id).toBe('empty');
    expect(drop).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(bindings.fs.promises.rm).not.toHaveBeenCalled();
    expect(bindings.fs.promises.rmdir).not.toHaveBeenCalled();
  });
});
