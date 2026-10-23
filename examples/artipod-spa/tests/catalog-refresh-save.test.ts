import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bindings = vi.hoisted(() => ({
  uiState: vi.fn(),
  ancestry: vi.fn(),
  patch: vi.fn(),
  fs: { promises: { readdir: vi.fn(async () => []), exists: vi.fn(async () => false) } },
}));

vi.mock('../lib/boot', () => ({ uiState: () => bindings.uiState(), keys: () => ({ getKey: () => null, reconcileOffline: () => {} }) }));
vi.mock('../lib/filesystem', () => ({ initFileSystem: async () => ({}), fs: bindings.fs }));
vi.mock('../lib/services/catalog-service', () => ({
  boundAncestry: () => bindings.ancestry(),
  computeVerdicts: async () => new Map([['private:_1', 'synced']]),
  healUnsynced: () => ['private:_1'],
}));
vi.mock('@artipod/core/oci', () => ({
  readPodSettings: async () => ({ offline: false }),
  OciStore: class {
    async init() {}
    async listRefs() { return [{ ref: 'private:_1', manifestDigest: 'sha256:local' }]; }
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
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('catalog refresh save ownership', () => {
  it.each(['initial', 'debounced'] as const)('drains a disposed %s scan without retaining its late lock failure', async phase => {
    const { createLocalCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { hostSave } = await import('../lib/services/host-save');
    const reading = deferred<void>();
    const registry = deferred<{ workspaces: [] }>();
    bindings.uiState.mockResolvedValue({ io: { read: () => { reading.resolve(); return registry.promise; } }, registry: {} });
    const refresh = createLocalCatalogRefresh();
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
    const { createLocalCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { hostSave } = await import('../lib/services/host-save');
    const failure = new Error('The active catalog scan could not read the registry');
    bindings.uiState.mockResolvedValue({ io: { read: async () => { throw failure; } }, registry: {} });
    const refresh = createLocalCatalogRefresh();
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
    const { createLocalCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { hostSave } = await import('../lib/services/host-save');
    const refresh = createLocalCatalogRefresh();
    refresh.schedule(300, vi.fn());
    refresh.dispose();
    await refresh.refresh();
    refresh.schedule(300, vi.fn());
    await vi.runAllTimersAsync();
    await hostSave.save(async () => {});
    expect(bindings.uiState).not.toHaveBeenCalled();
  });

  it('awaits verdict healing under its parent scan even when the catalog is disposed mid-verdict', async () => {
    const { createLocalCatalogRefresh } = await import('../lib/services/catalog-refresh');
    const { hostSave } = await import('../lib/services/host-save');
    const { catalogStore } = await import('../lib/stores/catalog');
    const verdictStarted = deferred<void>();
    const verdict = deferred<void>();
    bindings.uiState.mockResolvedValue({ io: { read: async () => ({ workspaces: [] }), drop: async () => {}, patch: bindings.patch }, registry: {} });
    bindings.patch.mockResolvedValue(undefined);
    bindings.ancestry.mockImplementation(async () => { verdictStarted.resolve(); await verdict.promise; return async () => true; });
    vi.stubGlobal('fetch', async () => Response.json([]));
    catalogStore.setState({ serverRefs: [{ ref: 'private:_1', manifestDigest: 'sha256:remote' }] });
    const refresh = createLocalCatalogRefresh();
    const scanning = refresh.refresh();
    await verdictStarted.promise;
    const flush = vi.fn(async () => {});
    const saving = hostSave.save(flush);
    refresh.dispose();
    await Promise.resolve();
    expect(flush).not.toHaveBeenCalled();
    verdict.resolve();
    await Promise.all([scanning, saving]);
    expect(bindings.patch).toHaveBeenCalledWith('private:_1', { unsynced: false });
    expect(flush).toHaveBeenCalled();
  });
});
