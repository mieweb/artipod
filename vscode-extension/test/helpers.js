'use strict';

const { fileURLToPath, pathToFileURL } = require('node:url');

class Disposable {
  constructor(callback) { this.callback = callback; }
  dispose() { this.callback(); }
}

class EventEmitter {
  constructor() { this.listeners = new Set(); }
  event = listener => { this.listeners.add(listener); return new Disposable(() => this.listeners.delete(listener)); };
  fire(value) { this.listeners.forEach(listener => listener(value)); }
  dispose() { this.listeners.clear(); }
}

function fromURL(value) {
  const url = new URL(value);
  return {
    scheme: url.protocol.slice(0, -1), authority: url.host, path: decodeURIComponent(url.pathname), query: url.search.slice(1), fragment: url.hash.slice(1),
    fsPath: url.protocol === 'file:' ? fileURLToPath(url) : undefined,
    toString: () => url.href
  };
}

function createVSCode() {
  const events = { create: new EventEmitter(), change: new EventEmitter(), delete: new EventEmitter() };
  const commands = new Map();
  const api = {
    events, commandsMap: commands, EventEmitter, Disposable,
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    FileSystemError: Object.fromEntries(['NoPermissions', 'FileNotFound', 'FileExists', 'FileIsADirectory', 'FileNotADirectory'].map(code => [code, uri => Object.assign(new Error(`${code}: ${uri}`), { code })])),
    Uri: {
      file: value => fromURL(pathToFileURL(value)),
      from: value => fromURL(`${value.scheme}://${value.authority}${value.path.split('/').map(encodeURIComponent).join('/')}`),
      parse: fromURL
    },
    workspace: {
      textDocuments: [], isTrusted: true,
      getConfiguration: () => ({ get: () => true }),
      createFileSystemWatcher: () => ({
        onDidCreate: events.create.event, onDidChange: events.change.event, onDidDelete: events.delete.event,
        dispose() {}
      }),
      registerFileSystemProvider: (scheme, provider) => { api.provider = provider; return new Disposable(() => {}); }
    },
    commands: {
      registerCommand: (name, handler) => { commands.set(name, handler); return new Disposable(() => commands.delete(name)); },
      executeCommand: (name, args) => name === 'workbench.files.action.refreshFilesExplorer' ? (api.explorerRefreshes = (api.explorerRefreshes ?? 0) + 1) : commands.get(name)(args)
    },
    env: {}, window: { showErrorMessage: message => { api.lastError = message; } }
  };
  return api;
}

module.exports = { createVSCode };
