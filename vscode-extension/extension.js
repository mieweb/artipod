'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { ArtipodFileSystemProvider, isWithin } = require('./filesystem-provider');
const { CheckpointBridge } = require('./checkpoint-bridge');

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

function activate(context, api) {
  const vscode = api || require('vscode');
  let manager;
  let activeWorkspace;

  const getManager = async () => {
    if (!vscode.workspace.getConfiguration('artipod.checkpoints').get('enabled', false)) {
      throw new Error('Artipod checkpoints are disabled. Enable artipod.checkpoints.enabled for this prototype.');
    }
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
        const filesystem = new ArtipodFileSystemProvider(vscode, backend, folders[0].uri);
        context.subscriptions.push(filesystem, vscode.workspace.registerFileSystemProvider('artipod', filesystem, { isCaseSensitive: process.platform !== 'win32' }));
        return { backend, filesystem, bridge: new CheckpointBridge(vscode, backend, path.join(context.globalStorageUri.fsPath, 'mappings'), folders[0].uri) };
      })().catch(error => { manager = undefined; activeWorkspace = undefined; throw error; });
    }
    return manager;
  };

  for (const operation of ['capture', 'restore', 'fork']) {
    context.subscriptions.push(vscode.commands.registerCommand(`_artipod.checkpoints.${operation}`, async payload => {
      const { bridge } = await getManager();
      return bridge[operation](payload);
    }));
  }
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
  // Register artipod: early for mirror documents reopened after window reload.
  // Checkpoint command activation itself remains awaited and reports all errors.
  if (vscode.workspace.getConfiguration('artipod.checkpoints').get('enabled', false)) {
    void getManager().catch(error => vscode.window.showErrorMessage(`Artipod: ${error.message}`));
  }
  return { getManager };
}

module.exports = { activate };
