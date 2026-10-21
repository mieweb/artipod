import { describe, expect, it, vi } from 'vitest';
import type { ZenFsLike } from '../sandbox/types.js';
import { OciStore } from '../oci/store.js';
import { SnapshotManager } from '../oci/snapshot.js';
import { invalidateStorageContext, registerStorageContext, registerStorageProjection, resolveStorageContext, assertStorageProjection, type StorageContext } from './context.js';

function fixture() {
  const mkdir = vi.fn();
  const writeFile = vi.fn();
  const zfs = { promises: { mkdir, writeFile } } as unknown as ZenFsLike;
  let active = true;
  const storage: StorageContext = Object.freeze({ zfs, protection: 'encrypted', backend: 'test', async flush() {}, assertAccess() {} });
  registerStorageContext(storage, { assertActive: () => { if (!active) throw new Error('Storage session closed'); } });
  return { storage, zfs, mkdir, writeFile, close: () => { active = false; invalidateStorageContext(storage); } };
}

describe('core storage capability', () => {
  it('rejects clones, other filesystems, and requested policy downgrades', () => {
    const { storage, zfs } = fixture();
    expect(resolveStorageContext(storage, zfs, 'protected')).toBe(storage);
    expect(() => resolveStorageContext({ ...storage }, zfs, 'protected')).toThrow('core storage context');
    expect(() => resolveStorageContext(storage, {} as ZenFsLike)).toThrow('does not own');
    expect(() => resolveStorageContext(storage, zfs, 'plaintext')).toThrow('downgraded');
  });

  it('rejects missing or forged low-level protected policy before metadata I/O', () => {
    const { zfs, mkdir, writeFile } = fixture();
    const raw = { promises: { mkdir, writeFile } } as unknown as ZenFsLike;
    expect(() => new OciStore(raw, { storagePolicy: 'protected' })).toThrow('core storage context');
    const store = new OciStore(zfs);
    expect(() => new SnapshotManager({ zfs: raw, store, roots: ['/'], storagePolicy: 'protected' })).toThrow('core storage context');
    expect(() => new SnapshotManager({ zfs, store, roots: ['/'], workspaceFs: raw })).toThrow('owning core storage filesystem');
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('invalidates inferred store access when its session closes', async () => {
    const { storage, zfs, mkdir, writeFile, close } = fixture();
    const store = new OciStore(zfs);
    close();
    expect(() => resolveStorageContext(storage)).toThrow('core storage context');
    await expect(store.init()).rejects.toThrow('core storage context');
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('accepts only projections registered to the same live context', () => {
    const { storage, close } = fixture();
    const upper = {} as import('@zenfs/core').FileSystem;
    registerStorageProjection(upper, storage);
    expect(() => assertStorageProjection(upper, storage)).not.toThrow();
    expect(() => assertStorageProjection({}, storage)).toThrow('owning core storage session');
    expect(() => assertStorageProjection(upper, fixture().storage)).toThrow('owning core storage session');
    close();
    expect(() => assertStorageProjection(upper, storage)).toThrow('core storage context');
  });
});
