'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ArtipodFileSystemProvider } = require('../filesystem-provider');
const { createVSCode } = require('./helpers');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-provider-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const workspacePath = path.join(temporary, 'workspace');
  await fs.mkdir(workspacePath);
  const { ArtipodWorkspace } = await import('../../src/checkpoints.js');
  const backend = await ArtipodWorkspace.open({ workspacePath, storePath: path.join(temporary, 'store') });
  const vscode = createVSCode();
  const provider = new ArtipodFileSystemProvider(vscode, backend, vscode.Uri.file(workspacePath));
  t.after(() => provider.dispose());
  return { temporary, workspacePath, backend, vscode, provider };
}

test('read/write mirror uses the same materialized filesystem as native tools', async t => {
  const { provider, workspacePath } = await fixture(t);
  const uri = provider.uri('space and #.txt');
  await provider.writeFile(uri, Buffer.from('mirror edit'), { create: true, overwrite: false });
  assert.equal(await fs.readFile(path.join(workspacePath, 'space and #.txt'), 'utf8'), 'mirror edit');
  await fs.writeFile(path.join(workspacePath, 'space and #.txt'), 'terminal edit');
  assert.equal((await provider.readFile(uri)).toString(), 'terminal edit');
  assert.equal((await provider.stat(uri)).type, 1);
  assert.deepEqual(await provider.readDirectory(provider.uri()), [['space and #.txt', 1]]);
  await assert.rejects(provider.writeFile(uri, Buffer.from('x'), { create: true, overwrite: false }), { code: 'FileExists' });
  await assert.rejects(provider.writeFile(provider.uri('missing'), Buffer.from('x'), { create: false, overwrite: true }), { code: 'FileNotFound' });
});

test('restore emits precise created/changed/deleted mirror events and root refresh', async t => {
  const { provider, workspacePath, backend } = await fixture(t);
  await fs.writeFile(path.join(workspacePath, 'edit.txt'), 'before');
  await fs.writeFile(path.join(workspacePath, 'deleted.txt'), 'before');
  const checkpoint = await backend.create();
  await fs.writeFile(path.join(workspacePath, 'edit.txt'), 'after');
  await fs.unlink(path.join(workspacePath, 'deleted.txt'));
  await fs.writeFile(path.join(workspacePath, 'created.txt'), 'after');
  const events = [];
  provider.onDidChangeFile(batch => events.push(...batch));
  await backend.restore(checkpoint.checkpointId);
  assert.deepEqual(new Map(events.map(event => [event.uri.path, event.type])), new Map([
    ['/edit.txt', 1], ['/deleted.txt', 2], ['/created.txt', 3], ['/', 1]
  ]));
});

test('native file watcher events forward terminal writes to artipod documents', async t => {
  const { provider, workspacePath, vscode } = await fixture(t);
  const events = [];
  provider.onDidChangeFile(batch => events.push(...batch));
  const uri = vscode.Uri.file(path.join(workspacePath, 'terminal.txt'));
  vscode.events.create.fire(uri);
  vscode.events.change.fire(uri);
  vscode.events.delete.fire(uri);
  vscode.events.change.fire(vscode.Uri.file(path.join(workspacePath, '..', 'outside.txt')));
  assert.deepEqual(events.map(event => [event.uri.path, event.type]), [['/terminal.txt', 2], ['/terminal.txt', 1], ['/terminal.txt', 3]]);
});

test('mirror rejects foreign roots, parent traversal and symlink escapes', async t => {
  const { provider, workspacePath, temporary } = await fixture(t);
  const foreign = { ...provider.uri('file.txt'), authority: 'another-root' };
  await assert.rejects(provider.readFile(foreign), { code: 'NoPermissions' });
  const traversal = { ...provider.uri(), path: '/../outside.txt' };
  await assert.rejects(provider.readFile(traversal), { code: 'NoPermissions' });
  await fs.mkdir(path.join(temporary, 'outside'));
  await fs.writeFile(path.join(temporary, 'outside', 'keep.txt'), 'keep');
  await fs.symlink(path.join(temporary, 'outside'), path.join(workspacePath, 'escape'));
  await assert.rejects(provider.readFile(provider.uri('escape/keep.txt')), { code: 'NoPermissions' });
  await assert.rejects(provider.writeFile(provider.uri('escape/new.txt'), Buffer.from('bad'), { create: true, overwrite: true }), { code: 'NoPermissions' });
  assert.equal(await fs.readFile(path.join(temporary, 'outside', 'keep.txt'), 'utf8'), 'keep');
});

test('rename cannot erase an ancestor or the workspace root', async t => {
  const { provider, workspacePath } = await fixture(t);
  await fs.mkdir(path.join(workspacePath, 'parent'));
  await fs.writeFile(path.join(workspacePath, 'parent', 'child.txt'), 'keep');
  await assert.rejects(provider.rename(provider.uri('parent/child.txt'), provider.uri('parent'), { overwrite: true }), { code: 'NoPermissions' });
  await assert.rejects(provider.delete(provider.uri(), { recursive: true }), { code: 'NoPermissions' });
  assert.equal(await fs.readFile(path.join(workspacePath, 'parent', 'child.txt'), 'utf8'), 'keep');
});
