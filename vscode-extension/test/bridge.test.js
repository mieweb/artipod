'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { CheckpointBridge } = require('../checkpoint-bridge');
const { activate } = require('../extension');
const { createVSCode } = require('./helpers');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-extension-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const workspacePath = path.join(temporary, 'workspace');
  await fs.mkdir(workspacePath);
  const vscode = createVSCode();
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath) }];
  const { ArtipodWorkspace } = await import('../../src/checkpoints.js');
  const backend = await ArtipodWorkspace.open({ workspacePath, storePath: path.join(temporary, 'store') });
  return { temporary, workspacePath, vscode, backend, bridge: new CheckpointBridge(vscode, backend, path.join(temporary, 'mappings'), vscode.Uri.file(workspacePath)) };
}

const request = { sessionId: 'chat/session', requestId: 'request-one', checkpointId: 'request-one' };

test('complete workspace restore includes saved editor work and terminal creates/deletes; mapping survives restart', async t => {
  const { temporary, workspacePath, vscode, backend, bridge } = await fixture(t);
  const editorFile = path.join(workspacePath, 'editor.txt');
  await fs.writeFile(editorFile, 'old disk content');
  await fs.writeFile(path.join(workspacePath, 'terminal-deleted.txt'), 'restore me');
  vscode.workspace.textDocuments.push({
    uri: vscode.Uri.file(editorFile), isDirty: true,
    async save() { await fs.writeFile(editorFile, 'pre-turn editor content'); this.isDirty = false; return true; }
  });
  const token = await bridge.capture(request);
  assert.equal((await backend.list())[0].origin, 'agent-turn');
  await fs.writeFile(editorFile, 'agent normal edit');
  execFileSync(process.execPath, ['-e', 'const fs=require("node:fs"); fs.writeFileSync("terminal-created.bin",Buffer.from([0,255,42])); fs.unlinkSync("terminal-deleted.txt"); fs.mkdirSync("empty-terminal-directory");'], { cwd: workspacePath });
  const restarted = new CheckpointBridge(vscode, backend, path.join(temporary, 'mappings'), vscode.Uri.file(workspacePath));
  assert.deepEqual(await restarted.capture(request), token, 'idempotent retry keeps the original snapshot');
  const restored = await restarted.restore(request);
  assert.equal(restored.rootId, token.rootId);
  assert.equal(restored.workspaceUri, vscode.Uri.file(workspacePath).toString());
  assert.equal(vscode.explorerRefreshes, 1);
  assert.ok(restored.workspaceAliases.includes(vscode.Uri.file(backend.workspacePath).toString()));
  assert.ok(restored.workspaceAliases.includes(`artipod://${backend.rootId}/`));
  assert.equal(await fs.readFile(editorFile, 'utf8'), 'pre-turn editor content');
  assert.equal(await fs.readFile(path.join(workspacePath, 'terminal-deleted.txt'), 'utf8'), 'restore me');
  await assert.rejects(fs.access(path.join(workspacePath, 'terminal-created.bin')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(workspacePath, 'empty-terminal-directory')), { code: 'ENOENT' });
  assert.deepEqual(new Map(restored.changes.map(change => [path.basename(vscode.Uri.parse(change.uri).fsPath), change.type])), new Map([
    ['editor.txt', 1], ['terminal-created.bin', 3], ['terminal-deleted.txt', 2], ['empty-terminal-directory', 3]
  ]));
});

test('unknown history is rejected without changing the workspace', async t => {
  const { workspacePath, bridge } = await fixture(t);
  await fs.writeFile(path.join(workspacePath, 'keep.txt'), 'keep');
  await assert.rejects(bridge.restore(request), /No Artipod snapshot/);
  assert.equal(await fs.readFile(path.join(workspacePath, 'keep.txt'), 'utf8'), 'keep');
});

test('failed dirty document save prevents checkpoint capture', async t => {
  const { workspacePath, vscode, bridge } = await fixture(t);
  vscode.workspace.textDocuments.push({ uri: vscode.Uri.file(path.join(workspacePath, 'dirty.txt')), isDirty: true, save: async () => false });
  await assert.rejects(bridge.capture(request), /Could not save/);
  await assert.rejects(bridge.restore(request), /No Artipod snapshot/);
});

test('native capture rejects dirty custom editors in the workspace or mirror before creating a snapshot', async t => {
  for (const scheme of ['file', 'artipod']) {
    await t.test(scheme, async t => {
      const { temporary, workspacePath, vscode, backend, bridge } = await fixture(t);
      const file = path.join(workspacePath, 'custom.bin');
      await fs.writeFile(file, 'saved custom editor content');
      const tab = {
        isDirty: true,
        input: { uri: scheme === 'file' ? vscode.Uri.file(file) : vscode.Uri.from({ scheme, authority: backend.rootId, path: '/custom.bin' }) }
      };
      vscode.window.tabGroups = { all: [{ tabs: [
        tab,
        { isDirty: true, input: { uri: vscode.Uri.file(path.join(temporary, 'outside.bin')) } }
      ] }] };
      await assert.rejects(bridge.capture(request), /Save the workspace/);
      assert.deepEqual(await backend.list(), [], 'a stale on-disk snapshot must not be created');
      assert.equal(await bridge.readMapping(request), undefined, 'a failed capture must not record the request');
      tab.isDirty = false;
      const token = await bridge.capture(request);
      assert.equal((await backend.list())[0].checkpointId, token.checkpointId, 'capture can retry once workspace editors are saved');
    });
  }
});

test('resuming a request requires an existing mapping and never invents a before-turn snapshot', async t => {
  const { workspacePath, vscode, backend, bridge } = await fixture(t);
  const editorPath = path.join(workspacePath, 'editor.txt');
  await fs.writeFile(editorPath, 'existing content');
  let captures = 0;
  const create = backend.create.bind(backend);
  backend.create = async (...args) => { captures++; return create(...args); };
  let saves = 0;
  const document = {
    uri: vscode.Uri.file(editorPath), isDirty: true,
    async save() { saves++; await fs.writeFile(editorPath, 'saved editor content'); this.isDirty = false; return true; }
  };
  vscode.workspace.textDocuments.push(document);
  await assert.rejects(bridge.capture({ ...request, requireExisting: true }), /resumed request/);
  assert.equal(captures, 0);
  assert.equal(saves, 0);
  assert.equal(await fs.readFile(editorPath, 'utf8'), 'existing content');
  const original = await bridge.capture(request);
  assert.equal(captures, 1);
  assert.equal(saves, 1);
  document.isDirty = true;
  await fs.writeFile(editorPath, 'agent turn content');
  assert.deepEqual(await bridge.capture({ ...request, requireExisting: true }), original);
  assert.equal(captures, 1);
  assert.equal(saves, 1);
  assert.equal(await fs.readFile(editorPath, 'utf8'), 'agent turn content');
});

test('fork isolates filesystem root and persists target conversation mapping', async t => {
  const { temporary, workspacePath, vscode, bridge } = await fixture(t);
  await fs.writeFile(path.join(workspacePath, 'fork.txt'), 'checkpoint content');
  const original = await bridge.capture(request);
  const targetPath = path.join(temporary, 'fork');
  await fs.mkdir(targetPath);
  const fork = await bridge.fork({ ...request, targetPath, targetSessionId: 'fork-session' });
  assert.notEqual(fork.rootId, original.rootId);
  assert.equal(fork.checkpointId, original.checkpointId);
  await fs.writeFile(path.join(targetPath, 'fork.txt'), 'fork changes');
  assert.equal(await fs.readFile(path.join(workspacePath, 'fork.txt'), 'utf8'), 'checkpoint content');
  const { ArtipodWorkspace } = await import('../../src/checkpoints.js');
  const backend = await ArtipodWorkspace.open({ workspacePath: targetPath, storePath: path.join(temporary, 'store') });
  const forkBridge = new CheckpointBridge(vscode, backend, path.join(temporary, 'mappings'));
  await forkBridge.restore({ ...request, sessionId: 'fork-session' });
  assert.equal(await fs.readFile(path.join(targetPath, 'fork.txt'), 'utf8'), 'checkpoint content');
});

test('activation registers the exact internal protocol and enforces workspace support', async t => {
  const { temporary, workspacePath, vscode } = await fixture(t);
  const context = { globalStorageUri: vscode.Uri.file(path.join(temporary, 'globalStorage')), subscriptions: [] };
  t.after(() => context.subscriptions.forEach(value => value.dispose()));
  const extension = await activate(context, vscode);
  await extension.getManager();
  const token = await vscode.commands.executeCommand('_artipod.checkpoints.capture', request);
  assert.equal(token.providerId, 'artipod');
  assert.ok(vscode.provider);
  await fs.writeFile(path.join(workspacePath, 'new.txt'), 'changed');
  const result = await vscode.commands.executeCommand('_artipod.checkpoints.restore', request);
  assert.deepEqual(result.changes, [{ uri: vscode.Uri.file(path.join(workspacePath, 'new.txt')).toString(), type: 3 }]);
  vscode.workspace.isTrusted = false;
  await assert.rejects(vscode.commands.executeCommand('_artipod.checkpoints.capture', request), /trusted local/);
});
