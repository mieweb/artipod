'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
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
  assert.deepEqual((await provider.readDirectory(provider.uri())).filter(([name]) => name !== '.artipod'), [['space and #.txt', 1]]);
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
  await assert.rejects(provider.stat(provider.uri('escape/keep.txt')), { code: 'NoPermissions' });
  await assert.rejects(provider.delete(provider.uri('escape/keep.txt'), { recursive: true }), { code: 'NoPermissions' });
  await assert.rejects(provider.rename(provider.uri('escape/keep.txt'), provider.uri('stolen.txt'), { overwrite: true }), { code: 'NoPermissions' });
  await assert.rejects(provider.writeFile(provider.uri('escape/new.txt'), Buffer.from('bad'), { create: true, overwrite: true }), { code: 'NoPermissions' });
  await fs.writeFile(path.join(workspacePath, 'source.txt'), 'source');
  await assert.rejects(provider.rename(provider.uri('source.txt'), provider.uri('escape'), { overwrite: true }), { code: 'NoPermissions' });
  await assert.rejects(provider.rename(provider.uri('source.txt'), provider.uri('escape/keep.txt'), { overwrite: true }), { code: 'NoPermissions' });
  assert.equal(await fs.readFile(path.join(workspacePath, 'source.txt'), 'utf8'), 'source');
  assert.equal(await fs.readFile(path.join(temporary, 'outside', 'keep.txt'), 'utf8'), 'keep');
});

test('restored broken and external symlinks remain visible and can be renamed or deleted without following targets', async t => {
  const { provider, workspacePath, temporary, backend, vscode } = await fixture(t);
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep outside');
  const links = [
    { name: 'broken-relative', target: '../outside/missing', readError: 'FileNotFound' },
    { name: 'broken-absolute', target: path.join(outside, 'missing'), readError: 'FileNotFound' },
    { name: 'external-file', target: path.join(outside, 'keep.txt'), readError: 'NoPermissions' },
    { name: 'external-directory', target: outside, readError: 'NoPermissions' }
  ];
  for (const link of links) { await fs.symlink(link.target, path.join(workspacePath, link.name)); }
  const snapshot = await backend.create();
  for (const link of links) { await fs.unlink(path.join(workspacePath, link.name)); }
  await backend.restore(snapshot.checkpointId);
  const entries = new Map(await provider.readDirectory(provider.uri()));
  for (const link of links) {
    const uri = provider.uri(link.name);
    assert.equal(entries.get(link.name), vscode.FileType.SymbolicLink);
    const metadata = await provider.stat(uri);
    assert.equal(metadata.type, vscode.FileType.SymbolicLink);
    assert.equal(metadata.size, (await fs.lstat(path.join(workspacePath, link.name))).size);
    await assert.rejects(provider.readFile(uri), { code: link.readError });
    await assert.rejects(provider.writeFile(uri, Buffer.from('do not follow'), { create: true, overwrite: true }), { code: 'NoPermissions' });
    await assert.rejects(provider.createDirectory(uri), { code: 'NoPermissions' });
    const renamed = `renamed-${link.name}`;
    await provider.rename(uri, provider.uri(renamed), { overwrite: false });
    await assert.rejects(fs.lstat(path.join(workspacePath, link.name)), { code: 'ENOENT' });
    assert.equal(await fs.readlink(path.join(workspacePath, renamed)), link.target);
    await provider.delete(provider.uri(renamed), { recursive: true });
    await assert.rejects(fs.lstat(path.join(workspacePath, renamed)), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
    assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep outside');
  }
  await assert.rejects(provider.rename(provider.uri('missing-source'), provider.uri('unused'), { overwrite: false }), { code: 'FileNotFound' });
});

test('stat keeps target type bits for valid internal symlinks', async t => {
  const { provider, workspacePath, vscode } = await fixture(t);
  await fs.writeFile(path.join(workspacePath, 'target.txt'), 'inside');
  await fs.mkdir(path.join(workspacePath, 'directory'));
  await fs.symlink('target.txt', path.join(workspacePath, 'file-link'));
  await fs.symlink('directory', path.join(workspacePath, 'directory-link'));
  assert.equal((await provider.stat(provider.uri('file-link'))).type, vscode.FileType.SymbolicLink | vscode.FileType.File);
  assert.equal((await provider.stat(provider.uri('directory-link'))).type, vscode.FileType.SymbolicLink | vscode.FileType.Directory);
  assert.equal((await provider.readFile(provider.uri('file-link'))).toString(), 'inside');
});

test('rename cannot erase an ancestor or the workspace root', async t => {
  const { provider, workspacePath } = await fixture(t);
  await fs.mkdir(path.join(workspacePath, 'parent'));
  await fs.writeFile(path.join(workspacePath, 'parent', 'child.txt'), 'keep');
  await assert.rejects(provider.rename(provider.uri('parent/child.txt'), provider.uri('parent'), { overwrite: true }), { code: 'NoPermissions' });
  await assert.rejects(provider.rename(provider.uri('parent'), provider.uri('parent/child.txt'), { overwrite: true }), { code: 'NoPermissions' });
  await assert.rejects(provider.rename(provider.uri('parent'), provider.uri(), { overwrite: true }), { code: 'NoPermissions' });
  await assert.rejects(provider.rename(provider.uri(), provider.uri('parent'), { overwrite: true }), { code: 'NoPermissions' });
  await assert.rejects(provider.delete(provider.uri(), { recursive: true }), { code: 'NoPermissions' });
  assert.equal(await fs.readFile(path.join(workspacePath, 'parent', 'child.txt'), 'utf8'), 'keep');
});

test('rename resolves directory aliases while replacing final symlinks themselves', async t => {
  const { provider, workspacePath } = await fixture(t);
  await fs.mkdir(path.join(workspacePath, 'a', 'b'), { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'a', 'b', 'file.txt'), 'source');
  await fs.writeFile(path.join(workspacePath, 'a', 'b', 'keep.txt'), 'keep');
  await fs.symlink('a', path.join(workspacePath, 'link'));
  const events = [];
  provider.onDidChangeFile(batch => events.push(...batch));
  const source = provider.uri('a/b/file.txt');
  await assert.rejects(provider.rename(source, provider.uri('link/b'), { overwrite: true }), { code: 'NoPermissions' });
  await provider.rename(source, provider.uri('link/b/file.txt'), { overwrite: true });
  assert.equal(await fs.readFile(path.join(workspacePath, 'a', 'b', 'file.txt'), 'utf8'), 'source');
  assert.deepEqual(events, [], 'renaming an entry to the same entry through an alias is a no-op');
  // The final symlink may point to a source ancestor, but removing the link
  // itself is safe and must not recursively delete its target.
  await provider.rename(source, provider.uri('link'), { overwrite: true });
  assert.equal(await fs.readFile(path.join(workspacePath, 'link'), 'utf8'), 'source');
  assert.equal(await fs.readFile(path.join(workspacePath, 'a', 'b', 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(fs.lstat(path.join(workspacePath, 'a', 'b', 'file.txt')), { code: 'ENOENT' });
});

test('mirror creation rejects dangling leaf and ancestor symlinks without changing outside paths', async t => {
  for (const targetType of ['relative', 'absolute']) {
    for (const position of ['leaf', 'ancestor']) {
      await t.test(`${targetType} ${position}`, async t => {
        const { provider, workspacePath, temporary } = await fixture(t);
        const outside = path.join(temporary, 'outside');
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
        const target = path.join(outside, 'missing');
        const link = path.join(workspacePath, 'link');
        const linkTarget = targetType === 'relative' ? path.relative(workspacePath, target) : target;
        await fs.symlink(linkTarget, link);
        const uri = provider.uri(position === 'leaf' ? 'link' : 'link/nested/new.txt');
        await assert.rejects(provider.writeFile(uri, Buffer.from('bad'), { create: true, overwrite: true }), { code: 'NoPermissions' });
        await assert.rejects(provider.createDirectory(uri), { code: 'NoPermissions' });
        await fs.writeFile(path.join(workspacePath, 'source.txt'), 'source');
        await assert.rejects(provider.rename(provider.uri('source.txt'), uri, { overwrite: true }), { code: 'NoPermissions' });
        assert.equal(await fs.readFile(path.join(workspacePath, 'source.txt'), 'utf8'), 'source');
        assert.equal(await fs.readlink(link), linkTarget, 'the rejected operation leaves the dangling link intact');
        assert.deepEqual(await fs.readdir(outside), ['keep.txt']);
        assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
        await assert.rejects(fs.lstat(target), { code: 'ENOENT' });
      });
    }
  }
});

test('rename overwrite replaces files, directories and internal symlinks', async t => {
  for (const sourceType of ['file', 'directory']) {
    for (const destinationType of ['file', 'directory', 'symlink']) {
      await t.test(`${sourceType} onto ${destinationType}`, async t => {
        const { provider, workspacePath } = await fixture(t);
        const source = path.join(workspacePath, 'source');
        const destination = path.join(workspacePath, 'destination');
        if (sourceType === 'directory') {
          await fs.mkdir(source);
          await fs.writeFile(path.join(source, 'child.txt'), 'source');
        } else { await fs.writeFile(source, 'source'); }
        if (destinationType === 'directory') {
          await fs.mkdir(destination);
          await fs.writeFile(path.join(destination, 'old.txt'), 'old');
        } else if (destinationType === 'symlink') {
          await fs.writeFile(path.join(workspacePath, 'target.txt'), 'keep target');
          await fs.symlink('target.txt', destination);
        } else { await fs.writeFile(destination, 'old'); }
        await assert.rejects(provider.rename(provider.uri('source'), provider.uri('destination'), { overwrite: false }), { code: 'FileExists' });
        assert.equal(await fs.readFile(sourceType === 'directory' ? path.join(source, 'child.txt') : source, 'utf8'), 'source');
        await provider.rename(provider.uri('source'), provider.uri('destination'), { overwrite: true });
        await assert.rejects(fs.lstat(source), { code: 'ENOENT' });
        assert.equal((await fs.lstat(destination)).isDirectory(), sourceType === 'directory');
        assert.equal(await fs.readFile(sourceType === 'directory' ? path.join(destination, 'child.txt') : destination, 'utf8'), 'source');
        if (sourceType === 'directory') { assert.deepEqual(await fs.readdir(destination), ['child.txt']); }
        if (destinationType === 'symlink') { assert.equal(await fs.readFile(path.join(workspacePath, 'target.txt'), 'utf8'), 'keep target'); }
      });
    }
  }
});

test('rename preserves native behavior for two hard links to the same inode', async t => {
  const { provider, workspacePath, temporary } = await fixture(t);
  const source = path.join(workspacePath, 'source.txt');
  const destination = path.join(workspacePath, 'destination.txt');
  await fs.writeFile(source, 'same inode');
  await fs.link(source, destination);
  await assert.rejects(provider.rename(provider.uri('source.txt'), provider.uri('destination.txt'), { overwrite: false }), { code: 'FileExists' });
  // Compare against native rename instead of assuming whether the platform
  // leaves both links in place when they identify the same file.
  const nativeSource = path.join(temporary, 'native-source.txt');
  const nativeDestination = path.join(temporary, 'native-destination.txt');
  await fs.writeFile(nativeSource, 'same inode');
  await fs.link(nativeSource, nativeDestination);
  await fs.rename(nativeSource, nativeDestination);
  await provider.rename(provider.uri('source.txt'), provider.uri('destination.txt'), { overwrite: true });
  const exists = filename => fs.lstat(filename).then(() => true, error => { if (error.code === 'ENOENT') { return false; } throw error; });
  assert.equal(await exists(source), await exists(nativeSource));
  assert.equal(await fs.readFile(destination, 'utf8'), 'same inode');
  assert.equal((await fs.lstat(destination)).nlink, (await fs.lstat(nativeDestination)).nlink);
});

test('case-only rename does not remove its source on a case-insensitive filesystem', async t => {
  const { provider, workspacePath } = await fixture(t);
  const source = path.join(workspacePath, 'name.txt');
  const destination = path.join(workspacePath, 'NAME.txt');
  await fs.writeFile(source, 'keep case-only rename');
  try { await fs.lstat(destination); }
  catch (error) {
    if (error.code !== 'ENOENT') { throw error; }
    t.skip('The test filesystem is case-sensitive.');
    return;
  }
  await assert.rejects(provider.rename(provider.uri('name.txt'), provider.uri('NAME.txt'), { overwrite: false }), { code: 'FileExists' });
  await provider.rename(provider.uri('name.txt'), provider.uri('NAME.txt'), { overwrite: true });
  assert.equal(await fs.readFile(destination, 'utf8'), 'keep case-only rename');
  const names = await fs.readdir(workspacePath);
  assert.ok(names.includes('NAME.txt'));
  assert.ok(!names.includes('name.txt'));
});

test('case-insensitive directory ancestry cannot erase source files and directory case-only rename still works', async t => {
  const { provider, workspacePath } = await fixture(t);
  const parent = path.join(workspacePath, 'Parent');
  await fs.mkdir(parent);
  await fs.writeFile(path.join(parent, 'child.txt'), 'keep');
  try { await fs.lstat(path.join(workspacePath, 'parent')); }
  catch (error) {
    if (error.code !== 'ENOENT') { throw error; }
    t.skip('The test filesystem is case-sensitive.');
    return;
  }
  await assert.rejects(provider.rename(provider.uri('Parent/child.txt'), provider.uri('parent'), { overwrite: true }), { code: 'NoPermissions' });
  await assert.rejects(provider.rename(provider.uri('parent'), provider.uri('Parent/child.txt'), { overwrite: true }), { code: 'NoPermissions' });
  await assert.rejects(provider.rename(provider.uri('parent'), provider.uri('Parent/new-child'), { overwrite: true }), { code: 'NoPermissions' });
  assert.deepEqual(await fs.readdir(parent), ['child.txt']);
  assert.equal(await fs.readFile(path.join(parent, 'child.txt'), 'utf8'), 'keep');
  await provider.rename(provider.uri('Parent'), provider.uri('PARENT'), { overwrite: true });
  assert.ok((await fs.readdir(workspacePath)).includes('PARENT'));
  assert.equal(await fs.readFile(path.join(workspacePath, 'PARENT', 'child.txt'), 'utf8'), 'keep');
});

test('failed overwrite rename preserves an existing file when its source parent is not writable', async t => {
  const { provider, workspacePath } = await fixture(t);
  const parent = path.join(workspacePath, 'read-only');
  const source = path.join(parent, 'source.txt');
  const destination = path.join(workspacePath, 'destination.txt');
  await fs.mkdir(parent);
  await fs.writeFile(source, 'keep source');
  await fs.writeFile(destination, 'keep destination');
  await fs.chmod(parent, 0o555);
  try {
    try {
      await fs.access(parent, constants.W_OK);
      t.skip('The current user or filesystem does not enforce this directory permission.');
      return;
    } catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) { throw error; } }
    await assert.rejects(provider.rename(provider.uri('read-only/source.txt'), provider.uri('destination.txt'), { overwrite: true }), { code: 'NoPermissions' });
    assert.equal(await fs.readFile(source, 'utf8'), 'keep source');
    assert.equal(await fs.readFile(destination, 'utf8'), 'keep destination');
  } finally { await fs.chmod(parent, 0o755); }
});
