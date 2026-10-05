'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { ArtipodFileSystemProvider, isWithin } = require('./filesystem-provider');
const { CheckpointBridge } = require('./checkpoint-bridge');
const { ArtipodTerminal, WorkspaceOperationGate } = require('./pod-terminal');
const { registerSnapshotCommands } = require('./workspace-snapshots');

async function loadBackend() {
  const bundled = path.join(__dirname, 'vendor', 'checkpoints.mjs');
  let modulePath = bundled;
  try { await fs.access(bundled); }
  catch (error) {
    if (error.code !== 'ENOENT') { throw error; }
    modulePath = path.join(__dirname, '..', 'src', 'checkpoints.js');
  }
  return import(pathToFileURL(modulePath).href);
}

async function workspaceIsCaseSensitive(workspacePath) {
  // The backend has already opened this control directory. Comparing a case
  // variant probes the actual workspace volume without creating probe files.
  const control = await fs.lstat(path.join(workspacePath, '.artipod'));
  let alternate;
  try { alternate = await fs.lstat(path.join(workspacePath, '.ARTIPOD')); }
  catch (error) {
    if (error.code === 'ENOENT') { return true; }
    throw error;
  }
  return control.dev !== alternate.dev || control.ino !== alternate.ino;
}

async function activate(context, api) {
  const vscode = api || require('vscode');
  let manager;
  let activeWorkspace;
  const gate = new WorkspaceOperationGate();

  const getManager = async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!vscode.workspace.isTrusted || folders?.length !== 1 || folders[0].uri.scheme !== 'file' || vscode.env.remoteName) {
      throw new Error('Artipod checkpoints require one trusted local file:// workspace folder.');
    }
    const workspacePath = folders[0].uri.fsPath;
    if (activeWorkspace && activeWorkspace !== workspacePath) {
      throw new Error('The Artipod workspace changed. Reload the window before checkpointing.');
    }
    if (!manager) {
      activeWorkspace = workspacePath;
      manager = (async () => {
        const { ArtipodWorkspace } = await loadBackend();
        const backend = await ArtipodWorkspace.open({ workspacePath, storePath: path.join(context.globalStorageUri.fsPath, 'store') });
        const isCaseSensitive = await workspaceIsCaseSensitive(backend.workspacePath);
        const filesystem = new ArtipodFileSystemProvider(vscode, backend, folders[0].uri);
        context.subscriptions.push(filesystem, vscode.workspace.registerFileSystemProvider('artipod', filesystem, { isCaseSensitive }));
        if (vscode.window.createStatusBarItem) {
          const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
          status.text = `$(terminal) Artipod ${backend.rootId.slice(0, 8)}`;
          status.tooltip = `Pod ${backend.rootId}\n/ = ${backend.workspacePath}\nOpen the Artipod terminal`;
          status.command = 'artipod.openPodTerminal';
          status.show();
          context.subscriptions.push(status);
        }
        return { backend, filesystem, bridge: new CheckpointBridge(vscode, backend, path.join(context.globalStorageUri.fsPath, 'mappings'), folders[0].uri) };
      })().catch(error => { manager = undefined; activeWorkspace = undefined; throw error; });
    }
    return manager;
  };

  for (const operation of ['capture', 'restore', 'fork']) {
    context.subscriptions.push(vscode.commands.registerCommand(`_artipod.checkpoints.${operation}`, async payload => {
      if (!vscode.workspace.getConfiguration('artipod.checkpoints').get('enabled', false)) {
        throw new Error('Artipod native chat integration is disabled. It requires artipod.checkpoints.enabled and a compatible editor core patch.');
      }
      const { bridge } = await getManager();
      return gate.checkpoint(() => bridge[operation](payload));
    }));
  }
  registerSnapshotCommands(vscode, context, getManager, gate);
  context.subscriptions.push(vscode.commands.registerCommand('artipod.openPodTerminal', async () => {
    const { backend } = await getManager();
    const pty = new ArtipodTerminal(vscode, backend, gate);
    context.subscriptions.push(pty);
    const terminal = vscode.window.createTerminal({ name: `Artipod ${backend.rootId.slice(0, 8)}`, pty });
    context.subscriptions.push(terminal);
    terminal.show();
    await pty.ready;
    return backend.rootId;
  }));
  context.subscriptions.push(vscode.commands.registerCommand('artipod.openMirror', async () => {
    const { backend, filesystem } = await getManager();
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const root = [filesystem.root, backend.workspacePath].find(candidate => activeUri?.scheme === 'file' && isWithin(candidate, activeUri.fsPath));
    if (!root) {
      throw new Error('Open a local workspace file before opening its Artipod mirror.');
    }
    const uri = filesystem.uri(path.relative(root, activeUri.fsPath));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    return uri;
  }));
  // Reopen existing pods for mirror documents/status after reload. A fresh
  // workspace is initialized only by an explicit Artipod command (or the
  // separately enabled experimental chat integration).
  await (async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!vscode.workspace.isTrusted || folders?.length !== 1 || folders[0].uri.scheme !== 'file' || vscode.env.remoteName) { return; }
    if (!vscode.workspace.getConfiguration('artipod.checkpoints').get('enabled', false)) {
      try { await fs.access(path.join(folders[0].uri.fsPath, '.artipod', 'superblock.json')); }
      catch (error) { if (error.code === 'ENOENT') { return; } throw error; }
    }
    await getManager();
  })().catch(error => {
    void vscode.window.showErrorMessage(`Artipod: ${error.message}`);
    throw error;
  });
  return { getManager };
}

module.exports = { activate };
