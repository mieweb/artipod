import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ArtipodWorkspace } from '../dist/checkpoint-workspace.js';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-checkpoint-safety-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspacePath = path.join(base, 'workspace');
  const storePath = path.join(base, 'mappings');
  await fs.mkdir(workspacePath);
  const workspace = await ArtipodWorkspace.open({ workspacePath, storePath });
  await fs.writeFile(path.join(workspacePath, 'a'), 'baseline');
  return { base, workspacePath, storePath, workspace };
}

for (const relative of ['.artipod/oci', '.artipod/oci/snapshots', '.artipod/oci/uncompressed/sha256', '.artipod/superblock.json']) {
  test(`rejects redirected ${relative} before opening or capturing a pod`, async t => {
    const { base, workspacePath, storePath, workspace } = await fixture(t);
    const entry = path.join(workspacePath, relative);
    const outside = path.join(base, 'outside');
    await fs.rename(entry, outside);
    await fs.symlink(outside, entry);
    const outsideState = async () => (await fs.lstat(outside)).isDirectory()
      ? await fs.readdir(outside, { recursive: true }) : await fs.readFile(outside, 'utf8');
    const before = await outsideState();
    await assert.rejects(workspace.create(), /Unsafe Artipod checkpoint metadata/);
    await assert.rejects(ArtipodWorkspace.open({ workspacePath, storePath }), /Unsafe Artipod checkpoint metadata/);
    assert.deepEqual(await outsideState(), before);
    assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'baseline');
  });
}

test('rejects hardlinked superblocks and snapshot metadata before restore mutates files', async t => {
  const { base, workspacePath, workspace } = await fixture(t);
  const checkpoint = await workspace.create();
  await fs.writeFile(path.join(workspacePath, 'a'), 'current work');
  for (const relative of ['.artipod/superblock.json', `.artipod/oci/snapshots/${checkpoint.checkpointId}.json`]) {
    const metadata = path.join(workspacePath, relative);
    const outside = path.join(base, 'outside');
    await fs.link(metadata, outside);
    const before = await fs.readFile(outside);
    await assert.rejects(workspace.restore(checkpoint.checkpointId), /Unsafe Artipod checkpoint metadata/);
    assert.deepEqual(await fs.readFile(outside), before);
    assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'current work');
    await fs.unlink(outside);
  }
});

for (const separateSources of [false, true]) {
  test(`concurrent forks reserve one destination (${separateSources ? 'different' : 'same'} source pods)`, async t => {
    const { base, workspacePath, storePath, workspace } = await fixture(t);
    const first = await workspace.create();
    let secondWorkspace = workspace;
    let secondPath = workspacePath;
    if (separateSources) {
      secondPath = path.join(base, 'second');
      await fs.mkdir(secondPath);
      secondWorkspace = await ArtipodWorkspace.open({ workspacePath: secondPath, storePath });
    }
    await fs.writeFile(path.join(secondPath, 'a'), 'second snapshot');
    const second = await secondWorkspace.create();
    const destination = path.join(base, 'fork');
    await fs.mkdir(destination);
    const results = await Promise.allSettled([
      workspace.fork(first.checkpointId, { workspacePath: destination }),
      secondWorkspace.fork(second.checkpointId, { workspacePath: destination }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failure = results.find(result => result.status === 'rejected');
    assert.match(failure.reason.message, /empty|reserved/);
    const winner = results.find(result => result.status === 'fulfilled').value;
    assert.equal(await fs.readFile(path.join(destination, 'a'), 'utf8'), results[0].status === 'fulfilled' ? 'baseline' : 'second snapshot');
    assert.equal(JSON.parse(await fs.readFile(path.join(destination, '.artipod/superblock.json'))).podId, winner.rootId);
    await assert.rejects(fs.access(path.join(destination, '.artipod/checkpoint-lock')), { code: 'ENOENT' });
  });
}

test('failed fork releases its destination reservation without deleting caller files', async t => {
  const { base, workspace } = await fixture(t);
  const destination = path.join(base, 'fork');
  await fs.mkdir(destination);
  await assert.rejects(workspace.fork('snap-000000000000', { workspacePath: destination }));
  await assert.rejects(fs.access(path.join(destination, '.artipod/checkpoint-lock')), { code: 'ENOENT' });
  assert.ok((await fs.stat(destination)).isDirectory());
});
