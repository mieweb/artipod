'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { activate } = require('../extension');
const { createVSCode } = require('./helpers');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-activation-'));
  const workspacePath = path.join(temporary, 'workspace');
  await fs.mkdir(workspacePath);
  const vscode = createVSCode();
  vscode.workspace.getConfiguration = () => ({ get: (_name, fallback) => fallback });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath) }];
  const context = { globalStorageUri: vscode.Uri.file(path.join(temporary, 'globalStorage')), subscriptions: [] };
  t.after(async () => {
    context.subscriptions.forEach(value => value.dispose());
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const { ArtipodWorkspace } = await import('../vendor/checkpoints.mjs');
  return { workspacePath, vscode, context, ArtipodWorkspace };
}

test('activation waits for an existing pod provider before allowing restored mirror reads', async t => {
  const { workspacePath, vscode, context, ArtipodWorkspace } = await fixture(t);
  const backend = await ArtipodWorkspace.open({ workspacePath, storePath: path.join(context.globalStorageUri.fsPath, 'store') });
  await fs.writeFile(path.join(workspacePath, 'restored.txt'), 'ready on activation');
  let releaseOpen;
  const delayedOpen = new Promise(resolve => { releaseOpen = resolve; });
  let notifyOpenStarted;
  const openStarted = new Promise(resolve => { notifyOpenStarted = resolve; });
  t.mock.method(ArtipodWorkspace, 'open', async () => {
    notifyOpenStarted();
    await delayedOpen;
    return backend;
  });
  const activation = Promise.resolve(activate(context, vscode));
  let settled = false;
  void activation.then(() => { settled = true; }, () => { settled = true; });
  await openStarted;
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(settled, false, 'activation must remain pending while the provider backend opens');
    assert.equal(vscode.provider, undefined);
  } finally { releaseOpen(); }
  const extension = await activation;
  assert.ok(vscode.provider, 'VS Code can dispatch the first artipod read immediately after activation');
  assert.equal((await extension.getManager()).backend.rootId, backend.rootId);
  assert.equal((await vscode.provider.readFile(vscode.provider.uri('restored.txt'))).toString(), 'ready on activation');
});

test('activation rejects and reports existing-pod initialization failure', async t => {
  const { workspacePath, vscode, context, ArtipodWorkspace } = await fixture(t);
  await ArtipodWorkspace.open({ workspacePath, storePath: path.join(context.globalStorageUri.fsPath, 'store') });
  t.mock.method(ArtipodWorkspace, 'open', async () => { throw new Error('Cannot reopen the pod'); });
  const messages = [];
  vscode.window.showErrorMessage = message => {
    messages.push(message);
    // Reporting the error must not wait for the user to dismiss a notification.
    return new Promise(() => {});
  };
  await assert.rejects(activate(context, vscode), /Cannot reopen the pod/);
  assert.deepEqual(messages, ['Artipod: Cannot reopen the pod']);
  assert.equal(vscode.provider, undefined);
});

test('activation leaves a fresh stock workspace untouched until an Artipod command runs', async t => {
  const { workspacePath, vscode, context, ArtipodWorkspace } = await fixture(t);
  const open = t.mock.method(ArtipodWorkspace, 'open', () => assert.fail('fresh workspace activation must stay lazy'));
  const extension = await activate(context, vscode);
  assert.equal(open.mock.callCount(), 0);
  assert.equal(vscode.provider, undefined);
  assert.equal(typeof extension.getManager, 'function');
  assert.ok(vscode.commandsMap.has('artipod.createSnapshot'));
  assert.ok(vscode.commandsMap.has('artipod.openPodTerminal'));
  await assert.rejects(fs.access(path.join(workspacePath, '.artipod')), { code: 'ENOENT' });
});
