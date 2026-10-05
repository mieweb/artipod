'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** A materialized local root mirrored at artipod://<root-id>/.
 * The real file:// folder remains the workspace so terminals and existing tools
 * see exactly the same files. No virtual filesystem is substituted for their cwd.
 */
class ArtipodFileSystemProvider {
  constructor(vscode, backend, workspaceUri = vscode.Uri.file(backend.workspacePath)) {
    this.vscode = vscode;
    this.backend = backend;
    this.root = path.resolve(workspaceUri.fsPath);
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.emitter.event;
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.root, '**/*'));
    this.subscriptions = [
      this.watcher.onDidCreate(uri => this.emitNative(uri, vscode.FileChangeType.Created)),
      this.watcher.onDidChange(uri => this.emitNative(uri, vscode.FileChangeType.Changed)),
      this.watcher.onDidDelete(uri => this.emitNative(uri, vscode.FileChangeType.Deleted))
    ];
    this.restoreSubscription = backend.onDidRestore(result => this.emitRestore(result));
  }

  uri(relativePath = '') {
    return this.vscode.Uri.from({ scheme: 'artipod', authority: this.backend.rootId, path: '/' + relativePath.split(path.sep).join('/') });
  }

  async localPath(uri, { allowMissing = false, followLeaf = true } = {}) {
    if (uri.scheme !== 'artipod' || uri.authority !== this.backend.rootId || uri.query || uri.fragment) {
      throw this.vscode.FileSystemError.NoPermissions(uri);
    }
    const candidate = path.resolve(this.root, '.' + uri.path);
    if (!isWithin(this.root, candidate)) {
      throw this.vscode.FileSystemError.NoPermissions(uri);
    }
    // Check existing ancestors too: a symlink must never turn a mirror write into
    // an operation outside the materialized root.
    // Entry operations (lstat, unlink, rename source) act on the final link
    // itself. Their parents still require the same containment validation.
    let ancestor = !followLeaf && candidate !== this.root ? path.dirname(candidate) : candidate;
    while (true) {
      try {
        const resolved = await fs.realpath(ancestor);
        const rootReal = await fs.realpath(this.root);
        if (!isWithin(rootReal, resolved)) {
          throw this.vscode.FileSystemError.NoPermissions(uri);
        }
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' || !allowMissing || ancestor === this.root) {
          throw this.convertError(error, uri);
        }
        // realpath also reports ENOENT for a dangling symlink. It is not a
        // missing path component: creating through it could escape the root.
        let info;
        try { info = await fs.lstat(ancestor); }
        catch (error) { if (error.code !== 'ENOENT') { throw this.convertError(error, uri); } }
        if (info?.isSymbolicLink()) { throw this.vscode.FileSystemError.NoPermissions(uri); }
        ancestor = path.dirname(ancestor);
      }
    }
    return candidate;
  }

  convertError(error, uri) {
    if (error.code === 'ENOENT') { return this.vscode.FileSystemError.FileNotFound(uri); }
    if (error.code === 'EEXIST') { return this.vscode.FileSystemError.FileExists(uri); }
    if (error.code === 'EISDIR') { return this.vscode.FileSystemError.FileIsADirectory(uri); }
    if (error.code === 'ENOTDIR') { return this.vscode.FileSystemError.FileNotADirectory(uri); }
    if (error.code === 'EACCES' || error.code === 'EPERM') { return this.vscode.FileSystemError.NoPermissions(uri); }
    return error;
  }

  async operation(uri, callback, options) {
    try { return await callback(await this.localPath(uri, options)); }
    catch (error) { throw this.convertError(error, uri); }
  }

  watch() { return new this.vscode.Disposable(() => {}); }

  stat(uri) {
    return this.operation(uri, async local => {
      const info = await fs.lstat(local);
      let type = info.isDirectory() ? this.vscode.FileType.Directory : this.vscode.FileType.File;
      if (info.isSymbolicLink()) {
        type = this.vscode.FileType.SymbolicLink;
        try {
          // Only inspect targets after validating their resolved location. A
          // broken or external link remains a visible, manageable link entry.
          const target = await fs.stat(await this.localPath(uri));
          type |= target.isDirectory() ? this.vscode.FileType.Directory : this.vscode.FileType.File;
        } catch (error) {
          const converted = this.convertError(error, uri);
          if (!['FileNotFound', 'FileNotADirectory', 'NoPermissions', 'ELOOP'].includes(converted.code)) { throw converted; }
        }
      }
      return { type, ctime: info.ctimeMs, mtime: info.mtimeMs, size: info.size };
    }, { followLeaf: false });
  }

  readDirectory(uri) {
    return this.operation(uri, async local => (await fs.readdir(local, { withFileTypes: true })).map(entry => [
      entry.name, entry.isDirectory() ? this.vscode.FileType.Directory : entry.isSymbolicLink() ? this.vscode.FileType.SymbolicLink : this.vscode.FileType.File
    ]));
  }

  readFile(uri) { return this.operation(uri, local => fs.readFile(local)); }

  async writeFile(uri, content, options) {
    await this.operation(uri, async local => {
      let exists = true;
      try { await fs.lstat(local); } catch (error) { if (error.code !== 'ENOENT') { throw error; } exists = false; }
      if (exists && !options.overwrite) { throw this.vscode.FileSystemError.FileExists(uri); }
      if (!exists && !options.create) { throw this.vscode.FileSystemError.FileNotFound(uri); }
      await fs.writeFile(local, content);
      this.emitter.fire([{ uri, type: exists ? this.vscode.FileChangeType.Changed : this.vscode.FileChangeType.Created }]);
    }, { allowMissing: true });
  }

  async createDirectory(uri) {
    await this.operation(uri, local => fs.mkdir(local, { recursive: true }), { allowMissing: true });
    this.emitter.fire([{ uri, type: this.vscode.FileChangeType.Created }]);
  }

  async delete(uri, options) {
    await this.operation(uri, async local => {
      if (local === this.root) { throw this.vscode.FileSystemError.NoPermissions(uri); }
      const info = await fs.lstat(local);
      if (info.isDirectory() && !options.recursive) { await fs.rmdir(local); }
      else { await fs.rm(local, { recursive: !!options.recursive }); }
    }, { followLeaf: false });
    this.emitter.fire([{ uri, type: this.vscode.FileChangeType.Deleted }]);
  }

  async rename(oldUri, newUri, options) {
    const source = await this.localPath(oldUri, { followLeaf: false });
    const destination = await this.localPath(newUri, { allowMissing: true });
    if (source === this.root || destination === this.root) { throw this.vscode.FileSystemError.NoPermissions(oldUri); }
    if (source === destination) { return; }
    if (isWithin(source, destination) || isWithin(destination, source)) { throw this.vscode.FileSystemError.NoPermissions(newUri); }
    // Resolve parent aliases before removing a destination. Leave the final
    // component unresolved: rename replaces a symlink, not its target.
    const sourceEntry = path.join(await fs.realpath(path.dirname(source)), path.basename(source));
    const destinationEntry = path.join(await fs.realpath(path.dirname(destination)), path.basename(destination));
    if (sourceEntry === destinationEntry) { return; }
    if (isWithin(sourceEntry, destinationEntry) || isWithin(destinationEntry, sourceEntry)) { throw this.vscode.FileSystemError.NoPermissions(newUri); }
    const sourceInfo = await fs.lstat(source).catch(error => { throw this.convertError(error, oldUri); });
    let destinationInfo;
    try {
      destinationInfo = await fs.lstat(destination);
    } catch (error) { if (error.code !== 'ENOENT') { throw this.convertError(error, newUri); } }
    // Actual directories need their final spelling canonicalized too, since
    // filesystem case aliases can otherwise conceal a source or destination
    // ancestor. lstat deliberately keeps final symlinks out of this check.
    const sourceTreeEntry = sourceInfo.isDirectory() ? await fs.realpath(source) : sourceEntry;
    const destinationTreeEntry = destinationInfo?.isDirectory() ? await fs.realpath(destination) : destinationEntry;
    if (sourceTreeEntry !== destinationTreeEntry && (isWithin(sourceTreeEntry, destinationTreeEntry) || isWithin(destinationTreeEntry, sourceTreeEntry))) {
      throw this.vscode.FileSystemError.NoPermissions(newUri);
    }
    if (destinationInfo && !options.overwrite) { throw this.vscode.FileSystemError.FileExists(newUri); }
    try { await fs.rename(source, destination); }
    catch (error) {
      // Preserve native replacement and its failure guarantees whenever it
      // works. Removal is only needed for incompatible destination types or
      // nonempty directories, never permission errors or the same inode.
      const sameEntry = destinationInfo && sourceInfo.dev === destinationInfo.dev && sourceInfo.ino === destinationInfo.ino;
      if (!options.overwrite || !destinationInfo || sameEntry || !['EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) {
        throw this.convertError(error, newUri);
      }
      try {
        await fs.rm(destination, { recursive: destinationInfo.isDirectory() });
        await fs.rename(source, destination);
      } catch (error) { throw this.convertError(error, newUri); }
    }
    this.emitter.fire([{ uri: oldUri, type: this.vscode.FileChangeType.Deleted }, { uri: newUri, type: this.vscode.FileChangeType.Created }]);
  }

  emitNative(uri, type) {
    const root = [this.root, this.backend.workspacePath].find(candidate => uri.scheme === 'file' && isWithin(candidate, uri.fsPath));
    if (root) {
      this.emitter.fire([{ uri: this.uri(path.relative(root, uri.fsPath)), type }]);
    }
  }

  emitRestore(result) {
    const types = { changed: this.vscode.FileChangeType.Changed, created: this.vscode.FileChangeType.Created, deleted: this.vscode.FileChangeType.Deleted };
    const events = result.changes.map(change => ({ uri: this.uri(change.path), type: types[change.type] }));
    if (events.length) {
      events.push({ uri: this.uri(), type: this.vscode.FileChangeType.Changed });
      this.emitter.fire(events);
    }
  }

  dispose() {
    this.restoreSubscription();
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.watcher.dispose();
    this.emitter.dispose();
  }
}

module.exports = { ArtipodFileSystemProvider, isWithin };
