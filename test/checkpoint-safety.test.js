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
import { sha256 } from '../dist/oci/digest.js';
import { indexTar, makeLayerIndexArtifact, writeTar } from '../dist/oci/tar.js';

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

for (const explicitRootId of [false, true]) {
  test(`rejects a zero-byte superblock before reopening ${explicitRootId ? 'with' : 'without'} an explicit root ID`, async t => {
    const { workspacePath, storePath, workspace } = await fixture(t);
    const checkpoint = await workspace.create({ label: 'preserve this checkpoint' });
    const checkpoints = await workspace.list();
    const superblockPath = path.join(workspacePath, '.artipod/superblock.json');
    const superblock = await fs.readFile(superblockPath);
    const metadata = path.join(workspacePath, '.artipod/oci/snapshots');
    const snapshotFiles = (await fs.readdir(metadata)).sort();
    const snapshotBytes = await Promise.all(snapshotFiles.map(name => fs.readFile(path.join(metadata, name))));
    const mappingDirectory = path.join(storePath, workspace.rootId);
    await fs.mkdir(mappingDirectory);
    const mappingPath = path.join(mappingDirectory, 'request.json');
    const mapping = JSON.stringify({ rootId: workspace.rootId, checkpointId: checkpoint.checkpointId });
    await fs.writeFile(mappingPath, mapping);
    await fs.writeFile(path.join(workspacePath, 'a'), 'current work');
    await fs.writeFile(superblockPath, '');

    await assert.rejects(ArtipodWorkspace.open({
      workspacePath, storePath, ...(explicitRootId ? { rootId: workspace.rootId } : {}),
    }), /JSON/);
    assert.equal((await fs.lstat(superblockPath)).size, 0);
    assert.equal(await fs.readFile(superblockPath, 'utf8'), '');
    assert.deepEqual((await fs.readdir(metadata)).sort(), snapshotFiles);
    assert.deepEqual(await Promise.all(snapshotFiles.map(name => fs.readFile(path.join(metadata, name)))), snapshotBytes);
    assert.deepEqual(await fs.readdir(storePath), [workspace.rootId]);
    assert.equal(await fs.readFile(mappingPath, 'utf8'), mapping);
    assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'current work');
    await assert.rejects(fs.access(path.join(workspacePath, '.artipod/checkpoint-lock')), { code: 'ENOENT' });

    // Repair only the caller-truncated bytes: reopening must retain the same
    // identity and make its existing mapping and checkpoint usable again.
    await fs.writeFile(superblockPath, superblock);
    const reopened = await ArtipodWorkspace.open({ workspacePath, storePath });
    assert.equal(reopened.rootId, workspace.rootId);
    assert.deepEqual(await reopened.list(), checkpoints);
    await reopened.restore(checkpoint.checkpointId);
    assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'baseline');
  });
}

for (const operation of ['restore', 'fork']) {
  test(`${operation} rejects an imported empty symlink target before materializing payload or deleting live files`, async t => {
    const { base, workspacePath, workspace } = await fixture(t);
    const checkpoint = await workspace.create();
    await fs.writeFile(path.join(workspacePath, 'a'), 'current work');
    await fs.mkdir(path.join(workspacePath, 'keep'));
    await fs.writeFile(path.join(workspacePath, 'keep', 'valuable'), 'keep this nested file');
    const current = await workspace.create();
    const metadata = path.join(workspacePath, '.artipod/oci');
    const manifestPath = path.join(metadata, 'snapshots', `${checkpoint.checkpointId}.json`);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const payload = new TextEncoder().encode('must not materialize');
    const entries = [
      { path: '/payload', type: 'file', mode: 0o644, content: payload },
      { path: '/z-empty-link', type: 'symlink', mode: 0o777, linkTarget: '' },
    ];
    const tar = writeTar(entries);
    const diffId = await sha256(tar);
    await fs.writeFile(path.join(metadata, 'uncompressed/sha256', diffId.slice(7)), tar);
    await fs.writeFile(path.join(metadata, 'indexes/sha256', `${diffId.slice(7)}.json`), JSON.stringify(makeLayerIndexArtifact(indexTar(tar))));
    manifest.diff = { diffId, size: tar.length, entryCount: entries.length };
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await fs.writeFile(path.join(metadata, 'snapshots', `${checkpoint.checkpointId}.index.json`), JSON.stringify({
      formatVersion: 1,
      files: {
        '/payload': { type: 'file', mode: 0o644, size: payload.length, contentDigest: await sha256(payload) },
        '/z-empty-link': { type: 'symlink', mode: 0o777, size: 0, linkTarget: '' },
      },
    }));
    const headPath = path.join(metadata, 'snapshots/HEAD');
    const head = await fs.readFile(headPath, 'utf8');
    assert.equal(head.trim(), current.checkpointId);
    if (operation === 'restore') {
      await assert.rejects(workspace.restore(checkpoint.checkpointId), /Invalid Artipod snapshot symlink/);
    } else {
      const destination = path.join(base, 'fork');
      await fs.mkdir(destination);
      await assert.rejects(workspace.fork(checkpoint.checkpointId, { workspacePath: destination }), /Invalid Artipod snapshot symlink/);
      assert.deepEqual((await fs.readdir(destination)).filter(name => name !== '.artipod'), []);
      await assert.rejects(fs.access(path.join(destination, '.artipod/checkpoint-lock')), { code: 'ENOENT' });
    }
    assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'current work');
    assert.equal(await fs.readFile(path.join(workspacePath, 'keep', 'valuable'), 'utf8'), 'keep this nested file');
    assert.equal(await fs.readFile(headPath, 'utf8'), head);
    await assert.rejects(fs.lstat(path.join(workspacePath, 'payload')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(workspacePath, '.artipod/checkpoint-lock')), { code: 'ENOENT' });
  });
}

test('capture rejects a native empty-target symlink without changing prior checkpoint metadata or mappings', async t => {
  const { workspacePath, storePath, workspace } = await fixture(t);
  const checkpoint = await workspace.create();
  const link = path.join(workspacePath, 'empty-link');
  try { await fs.symlink('', link); }
  catch (error) {
    if (!['ENOENT', 'EINVAL'].includes(error.code)) throw error;
    t.skip('The native filesystem does not support empty-target symlinks.');
    return;
  }
  await fs.writeFile(path.join(workspacePath, 'a'), 'current work');
  const metadata = path.join(workspacePath, '.artipod/oci/snapshots');
  const snapshotFiles = (await fs.readdir(metadata)).sort();
  const snapshotBytes = await Promise.all(snapshotFiles.map(name => fs.readFile(path.join(metadata, name))));
  const mappingDirectory = path.join(storePath, workspace.rootId);
  await fs.mkdir(mappingDirectory);
  const mappingPath = path.join(mappingDirectory, 'request.json');
  const mapping = JSON.stringify({ rootId: workspace.rootId, checkpointId: checkpoint.checkpointId });
  await fs.writeFile(mappingPath, mapping);

  await assert.rejects(workspace.create(), /Invalid Artipod snapshot symlink/);
  assert.deepEqual((await fs.readdir(metadata)).sort(), snapshotFiles);
  assert.deepEqual(await Promise.all(snapshotFiles.map(name => fs.readFile(path.join(metadata, name)))), snapshotBytes);
  assert.deepEqual(await fs.readdir(storePath), [workspace.rootId]);
  assert.equal(await fs.readFile(mappingPath, 'utf8'), mapping);
  assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'current work');
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
  assert.equal(await fs.readlink(link), '');
  await assert.rejects(fs.access(path.join(workspacePath, '.artipod/checkpoint-lock')), { code: 'ENOENT' });

  await workspace.restore(checkpoint.checkpointId);
  assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'baseline');
  await assert.rejects(fs.lstat(link), { code: 'ENOENT' });
});

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
