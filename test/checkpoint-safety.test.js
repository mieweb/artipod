import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import nativeFs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { ArtipodWorkspace } from '../dist/checkpoint-workspace.js';

const exec = promisify(execFile);

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
    assert.match(failure.reason.message, /empty|reserved|busy/);
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

test('fork rejects filesystem roots and empty home directories before reserving the destination', async t => {
  const { base, workspace, storePath } = await fixture(t);
  const checkpoint = await workspace.create();
  await assert.rejects(workspace.fork(checkpoint.checkpointId, { workspacePath: path.parse(base).root }), /dedicated workspace directory/);

  // Use an empty simulated home: a populated home would also be rejected by
  // the emptiness check and would hide the missing dedicated-directory check.
  const home = path.join(base, 'empty-home');
  const alias = path.join(base, 'home-link');
  await fs.mkdir(home);
  await fs.symlink(home, alias);
  t.mock.method(os, 'homedir', () => home);
  for (const workspacePath of [home, alias]) {
    await assert.rejects(ArtipodWorkspace.open({ workspacePath, storePath }), /dedicated workspace directory/);
    await assert.rejects(workspace.fork(checkpoint.checkpointId, { workspacePath }), /dedicated workspace directory/);
    assert.deepEqual(await fs.readdir(home), []);
  }
});

test('restore and fork finish HEAD and lock bookkeeping before applying an unsearchable root mode', async t => {
  const { base, workspacePath, workspace } = await fixture(t);
  const checkpoint = await workspace.create();
  const manifestPath = path.join(workspacePath, '.artipod/oci/snapshots', `${checkpoint.checkpointId}.json`);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  // Mode 000 is valid metadata but cannot be walked for a live capture.
  manifest.rootModes['/'] = 0;
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(workspacePath, 'a'), 'after');
  const observed = [];
  const dispose = workspace.onDidRestore(result => observed.push(result));
  t.after(dispose);
  try {
    const restored = await workspace.restore(checkpoint.checkpointId);
    assert.equal((await fs.lstat(workspacePath)).mode & 0o777, 0);
    assert.deepEqual(observed, [restored]);
    assert.ok(restored.changes.some(change => change.path === '' && change.kind === 'directory'));
  } finally {
    await fs.chmod(workspacePath, 0o700);
  }
  assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'baseline');
  assert.equal((await fs.readFile(path.join(workspacePath, '.artipod/oci/snapshots/HEAD'), 'utf8')).trim(), checkpoint.checkpointId);
  await assert.rejects(fs.access(path.join(workspacePath, '.artipod/checkpoint-lock')), { code: 'ENOENT' });

  const destination = path.join(base, 'fork');
  await fs.mkdir(destination);
  try {
    const forked = await workspace.fork(checkpoint.checkpointId, { workspacePath: destination });
    assert.notEqual(forked.rootId, workspace.rootId);
    assert.equal((await fs.lstat(destination)).mode & 0o777, 0);
  } finally {
    await fs.chmod(destination, 0o700);
  }
  assert.equal(await fs.readFile(path.join(destination, 'a'), 'utf8'), 'baseline');
  assert.equal((await fs.readFile(path.join(destination, '.artipod/oci/snapshots/HEAD'), 'utf8')).trim(), checkpoint.checkpointId);
  await assert.rejects(fs.access(path.join(destination, '.artipod/checkpoint-lock')), { code: 'ENOENT' });
});

for (const operation of ['restore', 'fork']) {
  test(`${operation} excludes another process until the final root mode is applied`, async t => {
    const { base, workspacePath, workspace } = await fixture(t);
    await fs.chmod(workspacePath, 0o500);
    const checkpoint = await workspace.create();
    await fs.chmod(workspacePath, 0o700);
    const destination = operation === 'restore' ? workspacePath : path.join(base, 'fork');
    if (operation === 'fork') await fs.mkdir(destination);
    const canonicalDestination = await fs.realpath(destination);
    const alias = path.join(base, 'alias');
    await fs.symlink(destination, alias);
    const originalChmod = nativeFs.chmod;
    let entered;
    let release;
    const finalizing = new Promise(resolve => { entered = resolve; });
    const continueFinalizing = new Promise(resolve => { release = resolve; });
    const chmodMock = t.mock.method(nativeFs, 'chmod', async (directory, mode) => {
      if (directory === canonicalDestination && mode === 0o500) {
        entered();
        await continueFinalizing;
      }
      return originalChmod(directory, mode);
    });
    syncBuiltinESMExports();
    const pending = operation === 'restore' ? workspace.restore(checkpoint.checkpointId) : workspace.fork(checkpoint.checkpointId, { workspacePath: destination });
    try {
      await Promise.race([finalizing, pending.then(() => { throw new Error('Operation completed without finalizing the root mode'); })]);
      await assert.rejects(fs.access(path.join(destination, '.artipod/checkpoint-lock')), { code: 'ENOENT' });
      // A distinct process, a symlink alias and another mapping store must all
      // address the same mutex while the root still has its temporary mode.
      const contender = await exec(process.execPath, ['--input-type=module', '-e', `
        import { ArtipodWorkspace } from ${JSON.stringify(new URL('../dist/checkpoint-workspace.js', import.meta.url).href)};
        try {
          const workspace = await ArtipodWorkspace.open({ workspacePath: process.argv[1], storePath: process.argv[2] });
          console.log(JSON.stringify({ checkpoint: await workspace.create() }));
        } catch (error) { console.log(JSON.stringify({ error: error.message })); }
      `, alias, path.join(base, 'other-mappings')]);
      assert.match(JSON.parse(contender.stdout).error, /checkpoint store is busy/);
      release();
      await pending;
      assert.equal((await fs.lstat(destination)).mode & 0o777, 0o500);
      const reopened = await ArtipodWorkspace.open({ workspacePath: alias, storePath: path.join(base, 'other-mappings') });
      assert.equal((await reopened.list()).length, 1, 'the contender did not capture the temporary root mode');
      const next = await reopened.create();
      const manifest = JSON.parse(await fs.readFile(path.join(destination, '.artipod/oci/snapshots', `${next.checkpointId}.json`), 'utf8'));
      assert.equal(manifest.rootModes['/'], 0o500);
    } finally {
      release();
      await pending.catch(() => {});
      chmodMock.mock.restore();
      syncBuiltinESMExports();
      await originalChmod(destination, 0o700);
    }
  });
}

for (const kind of ['symlink', 'file', 'public-directory']) {
  test(`rejects an unsafe external mutex directory (${kind}) without touching its contents`, async t => {
    const { base, workspace } = await fixture(t);
    const temporary = path.join(base, 'temporary');
    await fs.mkdir(temporary);
    const mutexDirectory = path.join(temporary, `artipod-checkpoints-${process.getuid()}`);
    const outside = path.join(base, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep'), 'untouched');
    if (kind === 'symlink') await fs.symlink(outside, mutexDirectory);
    else if (kind === 'file') await fs.writeFile(mutexDirectory, 'untouched');
    else {
      await fs.mkdir(mutexDirectory);
      await fs.chmod(mutexDirectory, 0o755);
    }
    t.mock.method(os, 'tmpdir', () => temporary);
    await assert.rejects(workspace.create(), /Unsafe Artipod checkpoint lock directory/);
    assert.deepEqual(await fs.readdir(outside), ['keep']);
    assert.equal(await fs.readFile(path.join(outside, 'keep'), 'utf8'), 'untouched');
    if (kind === 'file') assert.equal(await fs.readFile(mutexDirectory, 'utf8'), 'untouched');
    if (kind === 'public-directory') assert.deepEqual(await fs.readdir(mutexDirectory), []);
  });
}

test('rejects a workspace that would capture its external mutex directory', async t => {
  const { workspacePath, workspace } = await fixture(t);
  t.mock.method(os, 'tmpdir', () => workspacePath);
  await assert.rejects(workspace.create(), /must not contain the shared temporary checkpoint lock directory/);
  assert.deepEqual((await fs.readdir(workspacePath)).sort(), ['.artipod', 'a']);
});
