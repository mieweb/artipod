'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { saveWorkspaceDocuments } = require('./workspace-snapshots');

function validateContext(context) {
  if (!context || ['sessionId', 'requestId', 'checkpointId'].some(key => typeof context[key] !== 'string' || !context[key])) {
    throw new Error('Artipod checkpoint commands require sessionId, requestId and checkpointId.');
  }
  return { sessionId: context.sessionId, requestId: context.requestId, checkpointId: context.checkpointId };
}

function mappingKey(context) {
  return createHash('sha256').update(JSON.stringify([context.sessionId, context.requestId, context.checkpointId])).digest('hex');
}

/** Durable mapping of VS Code request boundaries to immutable Artipod snapshots. */
class CheckpointBridge {
  constructor(vscode, backend, mappingDirectory, workspaceUri = vscode.Uri.file(backend.workspacePath)) {
    this.vscode = vscode;
    this.backend = backend;
    this.mappingDirectory = mappingDirectory;
    // Preserve the URI spelling used by the workbench. realpath('/var/...') is
    // '/private/var/...' on macOS; returning that alias misses loaded models.
    this.workspaceUri = workspaceUri;
    this.workspacePath = workspaceUri.fsPath;
    this.queue = Promise.resolve();
  }

  serialized(operation) {
    const result = this.queue.catch(() => {}).then(operation);
    this.queue = result;
    return result;
  }

  mappingPath(context, rootId = this.backend.rootId) {
    return path.join(this.mappingDirectory, rootId, mappingKey(context) + '.json');
  }

  async readMapping(context) {
    const mapping = await fs.readFile(this.mappingPath(context), 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') { return undefined; }
      throw error;
    });
    if (mapping && (mapping.version !== 1 || mapping.rootId !== this.backend.rootId || mapping.providerId !== 'artipod' ||
      mappingKey(mapping.context) !== mappingKey(context) || !/^snap-[a-f0-9]{12}$/.test(mapping.checkpointId))) {
      throw new Error('The Artipod checkpoint mapping is invalid. Refusing to restore another workspace or request.');
    }
    return mapping;
  }

  async writeMapping(context, token) {
    const destination = this.mappingPath(context, token.rootId);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, context, ...token }), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  token(mapping) {
    return { providerId: 'artipod', checkpointId: mapping.checkpointId, rootId: mapping.rootId };
  }

  capture(input) {
    const context = validateContext(input);
    return this.serialized(async () => {
      // The first capture wins, even after extension/window restart. A retry must
      // not overwrite its pre-turn state with the already modified workspace.
      const existing = await this.readMapping(context);
      if (existing) { return this.token(existing); }
      if (input.requireExisting === true) {
        throw new Error('No Artipod snapshot exists for this resumed request. Refusing to create a checkpoint after the turn has started.');
      }
      const destination = this.mappingPath(context);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const lock = destination + '.lock';
      try { await fs.mkdir(lock); }
      catch (error) {
        if (error.code === 'EEXIST') { throw new Error(`Artipod checkpoint capture is already running (${lock}).`); }
        throw error;
      }
      try {
        const concurrent = await this.readMapping(context);
        if (concurrent) { return this.token(concurrent); }
        await saveWorkspaceDocuments(this.vscode, this.backend, this.workspaceUri);
        const token = this.token(await this.backend.create({ label: `${context.sessionId}/${context.requestId}/${context.checkpointId}`, origin: 'agent-turn' }));
        await this.writeMapping(context, token);
        return token;
      } finally { await fs.rmdir(lock); }
    });
  }

  restore(input) {
    const context = validateContext(input);
    return this.serialized(async () => {
      const mapping = await this.readMapping(context);
      if (!mapping) {
        throw new Error('No Artipod snapshot exists for this request checkpoint. Start a new turn with Artipod checkpoints enabled; historical turns cannot be restored as complete workspaces.');
      }
      const result = await this.backend.restore(mapping.checkpointId);
      const types = { changed: this.vscode.FileChangeType.Changed, created: this.vscode.FileChangeType.Created, deleted: this.vscode.FileChangeType.Deleted };
      await this.vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
      return {
        ...this.token(result),
        workspaceUri: this.workspaceUri.toString(),
        workspaceAliases: [
          this.vscode.Uri.file(this.backend.workspacePath).toString(),
          this.vscode.Uri.from({ scheme: 'artipod', authority: this.backend.rootId, path: '/' }).toString()
        ],
        changes: result.changes.map(change => ({ uri: this.vscode.Uri.file(path.join(this.workspacePath, change.path)).toString(), type: types[change.type] }))
      };
    });
  }

  fork(input) {
    const context = validateContext(input);
    if (typeof input.targetPath !== 'string' || !path.isAbsolute(input.targetPath)) {
      throw new Error('Artipod fork requires an absolute targetPath pointing to an empty directory.');
    }
    const targetContext = input.targetSessionId === undefined ? undefined : validateContext({ ...context, sessionId: input.targetSessionId });
    return this.serialized(async () => {
      const mapping = await this.readMapping(context);
      if (!mapping) { throw new Error('No Artipod snapshot exists for this request checkpoint.'); }
      const fork = await this.backend.fork(mapping.checkpointId, { workspacePath: input.targetPath });
      const token = { providerId: 'artipod', rootId: fork.rootId, checkpointId: mapping.checkpointId };
      if (targetContext) {
        await this.writeMapping(targetContext, token);
      }
      return { ...token, workspaceUri: this.vscode.Uri.file(fork.workspacePath).toString() };
    });
  }
}

module.exports = { CheckpointBridge, validateContext };
