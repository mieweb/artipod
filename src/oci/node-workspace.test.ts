import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeWorkspaceFs } from './node-workspace.js';
import { OciStore } from './store.js';
import { SnapshotManager } from './snapshot.js';

const device = vi.hoisted(() => ({ boundary: '' }));
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const onDevice = <T extends { dev: number | bigint }>(entry: string, stat: T): T => {
    // Real filesystem operations and bytes, with a device-boundary seam. Tests
    // need no mount privileges and also run on single-volume CI workers.
    if (device.boundary && (entry === device.boundary || entry.startsWith(`${device.boundary}${path.sep}`))) {
      return Object.assign(Object.create(stat), { dev: Number(stat.dev) + 1 });
    }
    return stat;
  };
  return { ...original,
    lstat: vi.fn(async (...args: Parameters<typeof original.lstat>) => onDevice(String(args[0]), await original.lstat(...args))),
    stat: vi.fn(async (...args: Parameters<typeof original.stat>) => onDevice(String(args[0]), await original.stat(...args))),
  };
});
const temporary: string[] = [];
afterEach(async () => {
  device.boundary = '';
  await Promise.all(temporary.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-volume-preflight-'));
  temporary.push(directory);
  const filesystem = createNativeWorkspaceFs(directory);
  const store = new OciStore(filesystem);
  await store.init();
  await fs.writeFile(path.join(directory, 'file'), 'saved');
  const snapshots = new SnapshotManager({ zfs: filesystem, store, roots: ['/'] });
  const saved = (await snapshots.create())!;
  return { directory, filesystem, snapshots, saved };
}
describe('native materialization volume preflight', () => {
  it('rejects a checkout below a different device before creating its destination', async () => {
    const { directory, snapshots, saved } = await fixture();
    await fs.mkdir(path.join(directory, 'mounted'));
    device.boundary = path.join(directory, 'mounted');
    await expect(snapshots.checkout(saved.id, '/mounted/branch')).rejects.toThrow(/mount boundary|volume/i);
    expect(await fs.readdir(device.boundary)).toEqual([]);
    expect(await fs.readFile(path.join(directory, 'file'), 'utf8')).toBe('saved');
    expect(await fs.readFile(path.join(directory, '.artipod/oci/snapshots/HEAD'), 'utf8')).toBe(saved.id);
  });

  it('rejects a new live nested mount absent from the snapshot before restore deletes anything', async () => {
    const { directory, snapshots, saved } = await fixture();
    await fs.mkdir(path.join(directory, 'mounted'));
    await fs.writeFile(path.join(directory, 'mounted/precious'), 'keep mounted work');
    await fs.writeFile(path.join(directory, 'file'), 'current work');
    device.boundary = path.join(directory, 'mounted');
    await expect(snapshots.restore(saved.id)).rejects.toThrow(/mount boundary|volume/i);
    expect(await fs.readFile(path.join(directory, 'mounted/precious'), 'utf8')).toBe('keep mounted work');
    expect(await fs.readFile(path.join(directory, 'file'), 'utf8')).toBe('current work');
    expect(await fs.readFile(path.join(directory, '.artipod/oci/snapshots/HEAD'), 'utf8')).toBe(saved.id);
  });

  it('rejects a probe anchor on another device instead of trusting its filename semantics', async () => {
    const { directory, filesystem } = await fixture();
    device.boundary = path.join(directory, '.artipod');
    await expect(filesystem.validateSnapshotPaths!(['/', '/one', '/two'])).rejects.toThrow(/mount boundary|volume/i);
    expect((await fs.readdir(device.boundary)).filter(name => name.startsWith('path-preflight-'))).toEqual([]);
  });

  it('checks an available real second volume before creating any filename probes there', async context => {
    const { directory, filesystem } = await fixture();
    const volume = await fs.stat('/Volumes/Case').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!volume || volume.dev === (await fs.stat(directory)).dev) {
      context.skip('A writable second native volume is unavailable.');
      return;
    }
    const foreign = await fs.mkdtemp('/Volumes/Case/artipod-volume-preflight-').catch(error => {
      if (error.code !== 'EACCES' && error.code !== 'EROFS') throw error;
      return undefined;
    });
    if (!foreign) { context.skip('The second native volume is not writable.'); return; }
    temporary.push(foreign);
    await fs.rename(path.join(directory, '.artipod'), path.join(directory, 'original-metadata'));
    await fs.symlink(foreign, path.join(directory, '.artipod'));
    await expect(filesystem.validateSnapshotPaths!(['/', '/one', '/two'])).rejects.toThrow(/volume/i);
    expect(await fs.readdir(foreign)).toEqual([]);
  });
});
