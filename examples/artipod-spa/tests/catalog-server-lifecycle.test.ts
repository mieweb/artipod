import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStateMedium, UiStateIO } from '../lib/services/ui-state';

const bindings = vi.hoisted(() => ({ uiState: vi.fn(), ancestry: vi.fn() }));
vi.mock('../lib/boot', () => ({ uiState: () => bindings.uiState(), keys: () => ({ getKey: () => null }) }));
vi.mock('../lib/filesystem', () => ({ fs: {}, initFileSystem: async () => ({}) }));
vi.mock('../lib/services/catalog-service', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/services/catalog-service')>(),
  boundAncestry: () => bindings.ancestry(),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

async function fixture() {
  const { catalogStore, refreshServer } = await import('../lib/stores/catalog');
  const { registryStore } = await import('../lib/stores/registry');
  const { createCatalogRefresh } = await import('../lib/services/catalog-refresh');
  const { hostSave } = await import('../lib/services/host-save');
  const io = new UiStateIO(memoryStateMedium());
  await io.recordWorkspace('private:_1', 'pod', 'rw');
  await io.patch('private:_1', { unsynced: true });
  // The catalog snapshots predate the workspace's next push attempt.
  registryStore.setState({ entries: (await io.read()).workspaces });
  catalogStore.setState({ localHeads: { 'private:_1': 'sha256:old-synced' } });
  await io.patch('private:_1', { unsynced: false });
  bindings.uiState.mockResolvedValue({ io });
  bindings.ancestry.mockResolvedValue(async () => false);
  return { io, refreshServer, owner: createCatalogRefresh(), hostSave };
}

describe('catalog server refresh lifetime', () => {
  it('preserves a new workspace push failure when its old catalog response arrives after disposal', async () => {
    const { io, owner, hostSave } = await fixture();
    const requested = deferred();
    const response = deferred();
    const refreshing = owner.refreshServer((async () => {
      requested.resolve();
      await response.promise;
      return Response.json([{ ref: 'private:_1', manifestDigest: 'sha256:old-synced' }]);
    }) as typeof fetch);
    await requested.promise;
    owner.dispose(); // Navigate from the catalog to the RW workspace.
    await io.patch('private:_1', { unsynced: true }); // Its new push fails.
    response.resolve();
    await refreshing;
    await hostSave.save(() => io.flush());
    expect((await io.read()).workspaces[0].unsynced).toBe(true);
  });

  it('skips stale verdict publication when disposal occurs during awaited ancestry work', async () => {
    const { io, owner, hostSave } = await fixture();
    const entered = deferred();
    const resume = deferred();
    bindings.ancestry.mockImplementation(async () => {
      entered.resolve();
      await resume.promise;
      return async () => false;
    });
    const refreshing = owner.refreshServer((async () => Response.json([{ ref: 'private:_1', manifestDigest: 'sha256:old-synced' }])) as typeof fetch);
    await entered.promise;
    owner.dispose();
    await io.patch('private:_1', { unsynced: true });
    resume.resolve();
    await refreshing;
    await hostSave.save(() => io.flush());
    expect((await io.read()).workspaces[0].unsynced).toBe(true);
  });

  it('keeps standalone inventory verdicts observational while preserving current failed-push state', async () => {
    const { io, refreshServer, hostSave } = await fixture();
    await io.patch('private:_1', { unsynced: true });
    await refreshServer((async () => Response.json([{ ref: 'private:_1', manifestDigest: 'sha256:old-synced' }])) as typeof fetch);
    await hostSave.save(() => io.flush());
    expect((await io.read()).workspaces[0].unsynced).toBe(true);
    const { catalogStore } = await import('../lib/stores/catalog');
    expect(catalogStore.getState().verdicts['private:_1']).toBe('synced');
  });

  it('preserves a newer failed push while a still-active catalog request finishes against cached heads', async () => {
    const { io, owner, hostSave } = await fixture();
    const requested = deferred();
    const response = deferred();
    const refreshing = owner.refreshServer((async () => {
      requested.resolve();
      await response.promise;
      return Response.json([{ ref: 'private:_1', manifestDigest: 'sha256:old-synced' }]);
    }) as typeof fetch);
    await requested.promise;
    await io.patch('private:_1', { unsynced: true });
    response.resolve();
    await refreshing;
    await hostSave.save(() => io.flush());
    expect((await io.read()).workspaces[0].unsynced).toBe(true);
  });
});
