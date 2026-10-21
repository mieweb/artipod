'use strict';

const { isWithin } = require('./filesystem-provider');

function isWorkspaceDocument(uri, backend, workspaceUri) {
  return uri.scheme === 'artipod' ? uri.authority === backend.rootId :
    uri.scheme === 'file' && (isWithin(workspaceUri.fsPath, uri.fsPath) || isWithin(backend.workspacePath, uri.fsPath));
}

async function saveWorkspaceDocuments(vscode, backend, workspaceUri) {
  for (const document of [...vscode.workspace.textDocuments, ...(vscode.workspace.notebookDocuments ?? [])]) {
    if (document.isDirty && isWorkspaceDocument(document.uri, backend, workspaceUri) && !await document.save()) {
      throw new Error(`Could not save ${document.uri.toString()} before the Artipod snapshot.`);
    }
  }
  // Custom editors do not expose a document.save() through the public API.
  // Do not silently capture stale disk contents beneath one of their buffers.
  for (const group of vscode.window.tabGroups?.all ?? []) {
    for (const tab of group.tabs) {
      const uri = tab.input?.uri ?? tab.input?.modified ?? tab.input?.notebookUri;
      if (tab.isDirty && uri && isWorkspaceDocument(uri, backend, workspaceUri)) {
        throw new Error('Save the workspace’s open editors before creating an Artipod snapshot.');
      }
    }
  }
}

/** Standalone snapshot commands. No chat IDs or patched workbench services. */
function registerSnapshotCommands(vscode, context, getManager, gate) {
  context.subscriptions.push(vscode.commands.registerCommand('artipod.createSnapshot', async () => {
    const label = await vscode.window.showInputBox({
      title: 'Create Artipod Workspace Snapshot',
      prompt: 'Save workspace files into a snapshot. Let terminal commands and background tasks finish first.',
      placeHolder: 'Optional snapshot label',
      ignoreFocusOut: true
    });
    if (label === undefined) { return; }
    const { backend, filesystem } = await getManager();
    const snapshot = await gate.checkpoint(async () => {
      await saveWorkspaceDocuments(vscode, backend, vscode.Uri.file(filesystem.root));
      return backend.create({ label: label.trim() || undefined });
    });
    void vscode.window.showInformationMessage(`Artipod snapshot created: ${snapshot.label || snapshot.checkpointId}`);
    return snapshot;
  }));

  context.subscriptions.push(vscode.commands.registerCommand('artipod.openSnapshot', async () => {
    const { backend } = await getManager();
    const snapshots = await gate.checkpoint(() => backend.list());
    if (!snapshots.length) {
      await vscode.window.showInformationMessage('This pod has no snapshots. Run Artipod: Create Workspace Snapshot first.');
      return;
    }
    const selected = await vscode.window.showQuickPick([...snapshots].reverse().map(snapshot => ({
      label: snapshot.label || snapshot.checkpointId,
      description: `${snapshot.checkpointId}${snapshot.isHead ? ' · current' : ''}`,
      detail: snapshot.createdAt,
      snapshot
    })), {
      title: 'Open Artipod Snapshot in New Workspace',
      placeHolder: 'Choose a snapshot to fork into an empty folder',
      matchOnDescription: true,
      ignoreFocusOut: true
    });
    if (!selected) { return; }
    const destinations = await vscode.window.showOpenDialog({
      title: 'Select an Empty Folder for the New Pod',
      openLabel: 'Fork Snapshot Here',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false
    });
    if (!destinations?.length) { return; }
    const target = destinations[0];
    if (target.scheme !== 'file') { throw new Error('Artipod snapshots require a local destination folder.'); }
    const fork = await gate.checkpoint(() => backend.fork(selected.snapshot.checkpointId, { workspacePath: target.fsPath }));
    await vscode.commands.executeCommand('vscode.openFolder', target, { forceNewWindow: true });
    return { rootId: fork.rootId, checkpointId: selected.snapshot.checkpointId, workspaceUri: target.toString() };
  }));
}

module.exports = { registerSnapshotCommands, saveWorkspaceDocuments };
