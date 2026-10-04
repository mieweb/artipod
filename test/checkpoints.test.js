import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { ArtipodWorkspace } from '../src/checkpoints.js';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-checkpoints-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspacePath = path.join(base, 'workspace');
  const storePath = path.join(base, 'store');
  await fs.mkdir(workspacePath);
  const workspace = await ArtipodWorkspace.open({ workspacePath, storePath });
  return { base, workspacePath, storePath, workspace };
}

async function snapshotTree(directory) {
  const entries = [];
  const visit = async prefix => {
    for (const name of (await fs.readdir(path.join(directory, prefix))).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, relative);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        entries.push([relative, 'symlink', await fs.readlink(absolute)]);
      } else if (stat.isDirectory()) {
        entries.push([relative, 'directory', stat.mode & 0o777]);
        await visit(relative);
      } else {
        entries.push([relative, 'file', stat.mode & 0o777, (await fs.readFile(absolute)).toString('base64')]);
      }
    }
  };
  await visit('');
  return entries;
}

test('restore captures editor and real terminal changes, ignored files, binaries, modes, empty dirs and symlinks', async t => {
  const { base, workspacePath, workspace } = await fixture(t);
  const outside = path.join(base, 'outside.txt');
  await fs.writeFile(outside, 'outside remains untouched');
  await fs.writeFile(path.join(workspacePath, 'editor.txt'), 'before editor\n');
  await fs.writeFile(path.join(workspacePath, 'terminal.txt'), 'before terminal\n');
  await fs.writeFile(path.join(workspacePath, 'removed.txt'), 'restore me\n');
  await fs.writeFile(path.join(workspacePath, '.gitignore'), 'ignored.bin\n');
  await fs.writeFile(path.join(workspacePath, 'ignored.bin'), Buffer.from([0, 255, 1, 128]));
  await fs.writeFile(path.join(workspacePath, 'run.sh'), '#!/bin/sh\necho before\n');
  await fs.chmod(path.join(workspacePath, 'run.sh'), 0o751);
  await fs.mkdir(path.join(workspacePath, 'empty'));
  await fs.mkdir(path.join(workspacePath, '.git'));
  await fs.writeFile(path.join(workspacePath, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.symlink(outside, path.join(workspacePath, 'outside-link'));
  await fs.symlink('missing-target', path.join(workspacePath, 'dangling'));
  const before = await snapshotTree(workspacePath);
  const checkpoint = await workspace.create();

  // This is the same materialized path an editor/file service writes to.
  await fs.writeFile(path.join(workspacePath, 'editor.txt'), 'agent editor edit\n');
  // This is an actual child process, not a mocked terminal change event.
  await exec(process.execPath, ['--input-type=module', '-e', `
    import * as fs from 'node:fs/promises';
    await fs.writeFile('terminal.txt', 'agent terminal edit\\n');
    await fs.rm('removed.txt');
    await fs.rm('empty', { recursive: true });
    await fs.writeFile('empty', 'directory became file');
    await fs.mkdir('generated/deep', { recursive: true });
    await fs.writeFile('generated/deep/new.bin', Buffer.from([9, 0, 8, 255]));
    await fs.writeFile('ignored.bin', Buffer.from([8, 7, 6]));
    await fs.chmod('run.sh', 0o600);
    await fs.rm('outside-link');
    await fs.symlink('terminal.txt', 'outside-link');
    await fs.writeFile('.git/HEAD', 'ref: refs/heads/agent\\n');
  `], { cwd: workspacePath });
  assert.notDeepEqual(await snapshotTree(workspacePath), before);
  const observed = [];
  const dispose = workspace.onDidRestore(event => observed.push(event));
  const restored = await workspace.restore(checkpoint.checkpointId);
  dispose();
  assert.deepEqual(await snapshotTree(workspacePath), before);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside remains untouched');
  assert.deepEqual(observed, [restored]);
  assert.equal(restored.rootId, checkpoint.rootId);
  assert.ok(restored.changes.some(change => change.path === 'editor.txt' && change.type === 'changed'));
  assert.ok(restored.changes.some(change => change.path === 'terminal.txt' && change.type === 'changed'));
  assert.ok(restored.changes.some(change => change.path === 'generated/deep/new.bin' && change.type === 'deleted'));
  assert.ok(restored.changes.some(change => change.path === 'removed.txt' && change.type === 'created'));
  assert.ok(restored.changes.some(change => change.path === 'empty' && change.type === 'deleted' && change.kind === 'file'));
  assert.ok(restored.changes.some(change => change.path === 'empty' && change.type === 'created' && change.kind === 'directory'));
  assert.deepEqual((await workspace.restore(checkpoint.checkpointId)).changes, []);
  assert.equal((await workspace.create()).checkpointId, checkpoint.checkpointId);
});

test('root/checkpoint IDs survive reopen and content IDs ignore timestamps', async t => {
  const { workspacePath, storePath, workspace } = await fixture(t);
  await fs.writeFile(path.join(workspacePath, 'a'), 'one');
  const checkpoint = await workspace.create({ label: 'before request' });
  await fs.utimes(path.join(workspacePath, 'a'), new Date(0), new Date(0));
  const reopened = await ArtipodWorkspace.open({ workspacePath, storePath });
  assert.equal(reopened.rootId, workspace.rootId);
  assert.equal((await reopened.create()).checkpointId, checkpoint.checkpointId);
  await fs.writeFile(path.join(workspacePath, 'a'), 'two');
  await reopened.restore(checkpoint.checkpointId);
  assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'one');
  await assert.rejects(ArtipodWorkspace.open({ workspacePath, storePath, rootId: '00000000-0000-0000-0000-000000000000' }), /binding/);
});

test('forks share immutable content but edits and restores remain isolated', async t => {
  const { base, workspacePath, workspace } = await fixture(t);
  await fs.writeFile(path.join(workspacePath, 'a'), 'baseline');
  const checkpoint = await workspace.create();
  const forkPath = path.join(base, 'fork');
  await fs.mkdir(forkPath);
  const fork = await workspace.fork(checkpoint.checkpointId, { workspacePath: forkPath });
  assert.notEqual(fork.rootId, workspace.rootId);
  assert.equal((await fork.create()).checkpointId, checkpoint.checkpointId);
  await fs.writeFile(path.join(forkPath, 'a'), 'fork edit');
  assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'baseline');
  await fs.writeFile(path.join(workspacePath, 'a'), 'source edit');
  await fork.restore(checkpoint.checkpointId);
  assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'source edit');
  assert.equal(await fs.readFile(path.join(forkPath, 'a'), 'utf8'), 'baseline');
  await assert.rejects(workspace.fork(checkpoint.checkpointId, { workspacePath: forkPath }), /empty/);
  await assert.rejects(workspace.fork(checkpoint.checkpointId, { workspacePath }), /distinct/);
});

test('corrupt or missing blobs and corrupt manifests fail before any mutation', async t => {
  const { workspacePath, storePath, workspace } = await fixture(t);
  await fs.writeFile(path.join(workspacePath, 'a'), 'baseline');
  await fs.writeFile(path.join(workspacePath, 'b'), 'second');
  const checkpoint = await workspace.create();
  const manifestFile = path.join(storePath, 'checkpoints', `${checkpoint.checkpointId}.json`);
  const originalManifest = await fs.readFile(manifestFile);
  const snapshot = JSON.parse(originalManifest);
  const blobFile = path.join(storePath, 'blobs', snapshot.entries[1].blob);
  const originalBlob = await fs.readFile(blobFile);
  await fs.writeFile(path.join(workspacePath, 'a'), 'valuable current work');
  await fs.writeFile(path.join(workspacePath, 'new'), 'do not delete');
  const current = await snapshotTree(workspacePath);
  await fs.writeFile(blobFile, 'corrupted blob');
  await assert.rejects(workspace.restore(checkpoint.checkpointId), /checksum/);
  assert.deepEqual(await snapshotTree(workspacePath), current);
  await fs.rm(blobFile);
  await assert.rejects(workspace.restore(checkpoint.checkpointId), /ENOENT/);
  assert.deepEqual(await snapshotTree(workspacePath), current);
  await fs.writeFile(blobFile, originalBlob);
  await fs.writeFile(manifestFile, '{}');
  await assert.rejects(workspace.restore(checkpoint.checkpointId), /checksum/);
  assert.deepEqual(await snapshotTree(workspacePath), current);
});

test('self-consistent malicious manifests cannot escape the workspace or write through symlink parents', async t => {
  const { base, workspacePath, storePath, workspace } = await fixture(t);
  await fs.writeFile(path.join(workspacePath, 'valuable'), 'keep');
  const before = await snapshotTree(workspacePath);
  const entries = [
    [{ path: '../escape', kind: 'directory', mode: 0o755 }],
    [{ path: '/absolute', kind: 'directory', mode: 0o755 }],
    [{ path: 'a\\..\\escape', kind: 'directory', mode: 0o755 }],
    [{ path: 'alias', kind: 'symlink', target: base }, { path: 'alias/escape', kind: 'directory', mode: 0o755 }],
    [{ path: 'missing/child', kind: 'directory', mode: 0o755 }],
    [{ path: 'duplicate', kind: 'directory', mode: 0o755 }, { path: 'duplicate', kind: 'directory', mode: 0o755 }]
  ];
  for (const maliciousEntries of entries) {
    const encoded = JSON.stringify({ version: 1, rootMode: 0o755, entries: maliciousEntries });
    const checkpointId = hash(encoded);
    await fs.writeFile(path.join(storePath, 'checkpoints', `${checkpointId}.json`), encoded);
    await assert.rejects(workspace.restore(checkpointId), /Invalid Artipod checkpoint/);
    assert.deepEqual(await snapshotTree(workspacePath), before);
  }
  await assert.rejects(workspace.restore('../../escape'), /checkpoint ID/);
});

test('rejects overlapping storage, roots replaced after open, non-empty forks and special files', async t => {
  const { base, workspacePath, storePath, workspace } = await fixture(t);
  await assert.rejects(ArtipodWorkspace.open({ workspacePath, storePath: path.join(workspacePath, 'store') }), /overlap/);
  await assert.rejects(ArtipodWorkspace.open({ workspacePath, storePath: base }), /overlap/);
  await fs.symlink(workspacePath, path.join(base, 'workspace-alias'));
  await assert.rejects(ArtipodWorkspace.open({ workspacePath, storePath: path.join(base, 'workspace-alias') }), /overlap/);
  await assert.rejects(ArtipodWorkspace.open({ workspacePath, storePath: path.join(base, 'workspace-alias', 'hidden-store') }), /overlap/);
  await assert.rejects(fs.lstat(path.join(workspacePath, 'hidden-store')), /ENOENT/);
  await fs.rename(workspacePath, `${workspacePath}-old`);
  await fs.mkdir(workspacePath);
  await assert.rejects(workspace.create(), /moved or replaced/);
  if (process.platform !== 'win32') {
    const reopened = await ArtipodWorkspace.open({ workspacePath, storePath });
    await exec('mkfifo', [path.join(workspacePath, 'fifo')]);
    await assert.rejects(reopened.create(), /Unsupported workspace entry/);
  }
});

test('restore preserves readonly directory permissions, directory replacement and root mode', async t => {
  const { workspacePath, workspace } = await fixture(t);
  const directory = path.join(workspacePath, 'readonly');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'a'), 'baseline');
  await fs.writeFile(path.join(workspacePath, 'becomes-directory'), 'baseline file');
  await fs.chmod(directory, 0o555);
  await fs.chmod(workspacePath, 0o755);
  const checkpoint = await workspace.create();
  await fs.chmod(directory, 0o755);
  await fs.writeFile(path.join(directory, 'a'), 'changed');
  await fs.chmod(directory, 0o555);
  await fs.rm(path.join(workspacePath, 'becomes-directory'));
  await fs.mkdir(path.join(workspacePath, 'becomes-directory'));
  await fs.writeFile(path.join(workspacePath, 'becomes-directory', 'new'), 'terminal');
  await fs.chmod(workspacePath, 0o700);
  await workspace.restore(checkpoint.checkpointId);
  assert.equal(await fs.readFile(path.join(directory, 'a'), 'utf8'), 'baseline');
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o555);
  assert.equal((await fs.stat(workspacePath)).mode & 0o777, 0o755);
  assert.equal(await fs.readFile(path.join(workspacePath, 'becomes-directory'), 'utf8'), 'baseline file');
  // Permit fixture cleanup even on platforms that enforce directory modes.
  await fs.chmod(directory, 0o755);
});

test('concurrent calls across instances serialize, foreign process locks fail safely, observer exceptions are isolated', async t => {
  const { workspacePath, storePath, workspace } = await fixture(t);
  await fs.writeFile(path.join(workspacePath, 'a'), 'baseline');
  const reopened = await ArtipodWorkspace.open({ workspacePath, storePath });
  const checkpoints = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? workspace : reopened).create()));
  assert.equal(new Set(checkpoints.map(checkpoint => checkpoint.checkpointId)).size, 1);
  const checkpoint = checkpoints[0];
  await fs.mkdir(path.join(storePath, '.checkpoint-lock'));
  await assert.rejects(workspace.restore(checkpoint.checkpointId), /store is busy/);
  await fs.rmdir(path.join(storePath, '.checkpoint-lock'));
  await fs.writeFile(path.join(workspacePath, 'a'), 'changed');
  workspace.onDidRestore(() => { throw new Error('broken observer'); });
  await workspace.restore(checkpoint.checkpointId);
  assert.equal(await fs.readFile(path.join(workspacePath, 'a'), 'utf8'), 'baseline');
});

test('restoring a hardlinked file does not modify content outside the workspace', async t => {
  const { base, workspacePath, workspace } = await fixture(t);
  const local = path.join(workspacePath, 'a');
  await fs.writeFile(local, 'baseline');
  const checkpoint = await workspace.create();
  await fs.writeFile(local, 'shared current content');
  const outside = path.join(base, 'hardlink');
  await fs.link(local, outside);
  await workspace.restore(checkpoint.checkpointId);
  assert.equal(await fs.readFile(local, 'utf8'), 'baseline');
  assert.equal(await fs.readFile(outside, 'utf8'), 'shared current content');
});
