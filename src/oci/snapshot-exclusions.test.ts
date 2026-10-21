import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeWorkspaceFs } from './node-workspace.js';
import { OciStore } from './store.js';
import { SnapshotManager } from './snapshot.js';

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) {
    await fs.chmod(directory, 0o700);
    for (const child of ['new', 'new/deep']) await fs.chmod(path.join(directory, child), 0o700).catch(error => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    });
    await fs.rm(directory, { recursive: true, force: true });
  }
});
async function fixture(exclusion: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-excluded-restore-'));
  temporary.push(directory);
  const filesystem = createNativeWorkspaceFs(directory);
  const store = new OciStore(filesystem);
  await store.init();
  const snapshots = new SnapshotManager({ zfs: filesystem, store, roots: ['/'], exclude: [exclusion] });
  return { directory, filesystem, snapshots };
}

describe('restore with nested exclusions', () => {
  it('removes ordinary added folders when the configured excluded entry is absent', async () => {
    const { directory, snapshots } = await fixture('/new/ignored');
    const saved = (await snapshots.create())!;
    await fs.mkdir(path.join(directory, 'new'));
    await fs.writeFile(path.join(directory, 'new/ordinary'), 'ordinary added file');
    const restored = await snapshots.restore(saved.id);
    await expect(fs.lstat(path.join(directory, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(restored.changes).toContainEqual({ path: '/new', type: 'deleted', kind: 'directory' });
  });

  it.each(['/new/ignored', '/new/deep/ignored'])('retains ancestors and modes needed by %s while restoring ordinary files', async exclusion => {
    const { directory, snapshots } = await fixture(exclusion);
    await fs.writeFile(path.join(directory, 'tracked'), 'saved');
    const saved = (await snapshots.create())!;
    const ignored = path.join(directory, exclusion);
    await fs.mkdir(ignored, { recursive: true });
    await fs.writeFile(path.join(ignored, 'private'), 'untouched excluded contents');
    await fs.writeFile(path.join(directory, 'new/ordinary'), 'remove this ordinary file');
    await fs.writeFile(path.join(directory, 'tracked'), 'current');
    const ancestors = [path.join(directory, 'new'), ...(exclusion.includes('/deep/') ? [path.join(directory, 'new/deep')] : [])];
    for (const ancestor of ancestors) await fs.chmod(ancestor, 0o500);
    await snapshots.create();
    const restored = await snapshots.restore(saved.id);
    expect(await fs.readFile(path.join(directory, 'tracked'), 'utf8')).toBe('saved');
    expect(await fs.readFile(path.join(ignored, 'private'), 'utf8')).toBe('untouched excluded contents');
    await expect(fs.lstat(path.join(directory, 'new/ordinary'))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const ancestor of ancestors) expect((await fs.stat(ancestor)).mode & 0o777).toBe(0o500);
    expect(restored.changes).not.toContainEqual(expect.objectContaining({ path: '/new', type: 'deleted' }));
    expect(await fs.readFile(path.join(directory, '.artipod/oci/snapshots/HEAD'), 'utf8')).toBe(saved.id);
  });

  it.for([
    { kind: 'file', name: 'new' }, { kind: 'symlink', name: 'new' },
    { kind: 'file', name: 'NEW' }, { kind: 'symlink', name: 'NEW' },
  ] as const)('rejects a target $kind at $name replacing an exclusion ancestor before any live mutation', async ({ kind, name }, context) => {
    const { directory, filesystem, snapshots } = await fixture('/new/deep/ignored');
    const ancestor = path.join(directory, 'new');
    const savedPath = path.join(directory, name);
    if (kind === 'file') await fs.writeFile(savedPath, 'saved file');
    else await fs.symlink('target', savedPath);
    if (name !== 'new') {
      const alias = await fs.lstat(ancestor).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
      if (!alias || alias.ino !== (await fs.lstat(savedPath)).ino) {
        context.skip('The test filesystem distinguishes these path spellings.');
        return;
      }
    }
    await fs.writeFile(path.join(directory, 'valuable'), 'saved');
    const saved = (await snapshots.create())!;
    await fs.unlink(savedPath);
    await fs.mkdir(path.join(ancestor, 'deep/ignored'), { recursive: true });
    await fs.writeFile(path.join(ancestor, 'deep/ignored/private'), 'excluded');
    await fs.writeFile(path.join(ancestor, 'ordinary'), 'current ordinary');
    await fs.writeFile(path.join(directory, 'valuable'), 'valuable current work');
    const current = (await snapshots.create())!;
    await fs.chmod(ancestor, 0o500);
    const mutations = (['mkdir', 'rmdir', 'unlink', 'chmod', 'writeFile', 'symlink'] as const).map(method => vi.spyOn(filesystem.promises, method));
    await expect(snapshots.restore(saved.id)).rejects.toThrow(/excluded.*ancestor|filesystem-equivalent/i);
    for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(directory, 'valuable'), 'utf8')).toBe('valuable current work');
    expect(await fs.readFile(path.join(ancestor, 'ordinary'), 'utf8')).toBe('current ordinary');
    expect(await fs.readFile(path.join(ancestor, 'deep/ignored/private'), 'utf8')).toBe('excluded');
    expect((await fs.stat(ancestor)).mode & 0o777).toBe(0o500);
    expect(await fs.readFile(path.join(directory, '.artipod/oci/snapshots/HEAD'), 'utf8')).toBe(current.id);
  });
});
