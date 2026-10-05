'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { activate } = require('../extension');
const { createVSCode } = require('./helpers');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-standalone-'));
  const workspacePath = path.join(temporary, 'workspace');
  await fs.mkdir(workspacePath);
  const vscode = createVSCode();
  vscode.workspace.getConfiguration = () => ({ get: (_name, fallback) => fallback });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath) }];
  vscode.workspace.notebookDocuments = [];
  const messages = [];
  const opened = [];
  const terminals = [];
  vscode.window.showInformationMessage = async message => { messages.push(message); };
  vscode.window.showInputBox = async () => 'Before experiment';
  vscode.window.showQuickPick = async items => items[0];
  vscode.window.showOpenDialog = async () => undefined;
  vscode.window.createTerminal = ({ pty }) => {
    terminals.push(pty);
    pty.open();
    return { show() {}, dispose() { pty.dispose(); } };
  };
  const execute = vscode.commands.executeCommand;
  vscode.commands.executeCommand = (name, ...args) => name === 'vscode.openFolder' ? opened.push(args) : execute(name, ...args);
  const context = { globalStorageUri: vscode.Uri.file(path.join(temporary, 'globalStorage')), subscriptions: [] };
  const extension = activate(context, vscode);
  t.after(async () => {
    context.subscriptions.forEach(value => value.dispose());
    await Promise.all(terminals.map(terminal => terminal.worker?.terminate()));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return { temporary, workspacePath, vscode, extension, messages, opened, terminals };
}

test('stock VS Code commands initialize a pod without enabling native chat checkpoints', async t => {
  const { workspacePath, vscode, extension, terminals } = await fixture(t);
  await assert.rejects(fs.access(path.join(workspacePath, '.artipod')), { code: 'ENOENT' });
  const rootId = await vscode.commands.executeCommand('artipod.openPodTerminal');
  const { backend } = await extension.getManager();
  assert.equal(rootId, backend.rootId);
  assert.equal(await terminals[0].ready, rootId);
  await assert.rejects(vscode.commands.executeCommand('_artipod.checkpoints.capture', {
    sessionId: 'chat', requestId: 'turn', checkpointId: 'turn'
  }), /native chat integration is disabled/);
  assert.deepEqual(await backend.list(), [], 'opening a terminal does not create a chat checkpoint');
});

test('snapshot cancellation does not initialize the folder', async t => {
  const { workspacePath, vscode } = await fixture(t);
  vscode.window.showInputBox = async () => undefined;
  assert.equal(await vscode.commands.executeCommand('artipod.createSnapshot'), undefined);
  await assert.rejects(fs.access(path.join(workspacePath, '.artipod')), { code: 'ENOENT' });
});

test('manual snapshot saves scoped documents and forks persisted history without overwriting current work', async t => {
  const { temporary, workspacePath, vscode, extension, opened } = await fixture(t);
  const { backend } = await extension.getManager();
  const file = path.join(workspacePath, 'editor.txt');
  const notebook = path.join(workspacePath, 'notebook.ipynb');
  const mirror = path.join(workspacePath, 'mirror.txt');
  const document = (uri, target, content) => ({
    uri, isDirty: true,
    async save() { await fs.writeFile(target, content); this.isDirty = false; return true; }
  });
  vscode.workspace.textDocuments.push(document(vscode.Uri.file(file), file, 'saved editor'));
  vscode.workspace.textDocuments.push(document(vscode.Uri.from({ scheme: 'artipod', authority: backend.rootId, path: '/mirror.txt' }), mirror, 'saved mirror'));
  vscode.workspace.notebookDocuments.push(document(vscode.Uri.file(notebook), notebook, '{"cells":[]}'));
  vscode.workspace.textDocuments.push({ uri: vscode.Uri.file(path.join(temporary, 'outside.txt')), isDirty: true, save() { assert.fail('must not save outside the workspace'); } });
  const snapshot = await vscode.commands.executeCommand('artipod.createSnapshot');
  assert.equal(snapshot.label, 'Before experiment');
  assert.equal((await backend.list())[0].checkpointId, snapshot.checkpointId);
  assert.equal((await backend.list())[0].origin, 'manual');
  await fs.writeFile(file, 'new work on disk');
  vscode.workspace.textDocuments[0].isDirty = true;
  vscode.workspace.textDocuments[0].save = () => assert.fail('fork must leave dirty source buffers alone');
  const destination = path.join(temporary, 'fork');
  await fs.mkdir(destination);
  vscode.window.showOpenDialog = async () => [vscode.Uri.file(destination)];
  const result = await vscode.commands.executeCommand('artipod.openSnapshot');
  assert.notEqual(result.rootId, backend.rootId);
  assert.equal(result.checkpointId, snapshot.checkpointId);
  assert.equal(await fs.readFile(path.join(destination, 'editor.txt'), 'utf8'), 'saved editor');
  assert.equal(await fs.readFile(path.join(destination, 'mirror.txt'), 'utf8'), 'saved mirror');
  assert.equal(await fs.readFile(path.join(destination, 'notebook.ipynb'), 'utf8'), '{"cells":[]}');
  assert.equal(await fs.readFile(file, 'utf8'), 'new work on disk');
  assert.equal(vscode.workspace.textDocuments[0].isDirty, true);
  assert.equal(opened[0][0].fsPath, destination);
  assert.deepEqual(opened[0][1], { forceNewWindow: true });
});

test('failed saves and unsaved custom editors prevent snapshots', async t => {
  const { workspacePath, vscode, extension } = await fixture(t);
  const file = vscode.Uri.file(path.join(workspacePath, 'dirty.txt'));
  vscode.workspace.textDocuments.push({ uri: file, isDirty: true, save: async () => false });
  await assert.rejects(vscode.commands.executeCommand('artipod.createSnapshot'), /Could not save/);
  const { backend } = await extension.getManager();
  assert.deepEqual(await backend.list(), []);
  vscode.workspace.textDocuments = [];
  vscode.window.tabGroups = { all: [{ tabs: [{ isDirty: true, input: { uri: file } }] }] };
  await assert.rejects(vscode.commands.executeCommand('artipod.createSnapshot'), /Save the workspace/);
  assert.deepEqual(await backend.list(), []);
});

test('empty history and dismissed pickers do not fork; occupied destinations are preserved', async t => {
  const { temporary, vscode, extension, messages, opened } = await fixture(t);
  assert.equal(await vscode.commands.executeCommand('artipod.openSnapshot'), undefined);
  assert.match(messages.at(-1), /no snapshots/);
  await vscode.commands.executeCommand('artipod.createSnapshot');
  vscode.window.showQuickPick = async () => undefined;
  assert.equal(await vscode.commands.executeCommand('artipod.openSnapshot'), undefined);
  vscode.window.showQuickPick = async items => items[0];
  assert.equal(await vscode.commands.executeCommand('artipod.openSnapshot'), undefined);
  const destination = path.join(temporary, 'occupied');
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'keep.txt'), 'precious work');
  vscode.window.showOpenDialog = async () => [vscode.Uri.file(destination)];
  await assert.rejects(vscode.commands.executeCommand('artipod.openSnapshot'), /must be empty/);
  assert.equal(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8'), 'precious work');
  assert.deepEqual(opened, []);
  assert.equal((await (await extension.getManager()).backend.list()).length, 1);
});
