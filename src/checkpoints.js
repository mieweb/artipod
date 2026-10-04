import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const VERSION = 1;
const ID = /^[a-f0-9]{64}$/;
const ROOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const queues = new Map();
const digest = value => createHash('sha256').update(value).digest('hex');
const encode = value => JSON.stringify(value);
const isWithin = (parent, child) => parent === child || (!path.relative(parent, child).startsWith(`..${path.sep}`) && path.relative(parent, child) !== '..' && !path.isAbsolute(path.relative(parent, child)));
const exists = async value => fs.lstat(value).catch(error => { if (error.code === 'ENOENT') { return undefined; } throw error; });
const invalid = detail => new Error(`Invalid Artipod checkpoint: ${detail}`);

// Resolve existing ancestors before creating a missing store. This avoids even
// creating an empty store inside the workspace through a symlink alias.
async function canonicalCandidate(candidate) {
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if (error.code !== 'ENOENT') { throw error; }
    const parent = path.dirname(candidate);
    if (parent === candidate) { throw error; }
    return path.join(await canonicalCandidate(parent), path.basename(candidate));
  }
}

function assertCheckpointId(value) {
  if (typeof value !== 'string' || !ID.test(value)) { throw invalid('checkpoint ID'); }
}

function assertRootId(value) {
  if (typeof value !== 'string' || !ROOT_ID.test(value)) { throw new Error('Invalid Artipod root ID'); }
}

function assertRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..') || path.posix.isAbsolute(value)) {
    throw invalid(`unsafe entry path ${JSON.stringify(value)}`);
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function atomicWrite(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

// A process queue provides ordering; an exclusive directory rejects overlapping
// processes. A crashed process leaves a lock for explicit operator recovery.
async function serialized(storePath, operation) {
  const previous = queues.get(storePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const lock = path.join(storePath, '.checkpoint-lock');
    try {
      await fs.mkdir(lock);
    } catch (error) {
      if (error.code === 'EEXIST') { throw new Error(`Artipod checkpoint store is busy (${lock}); stop its owner before removing a stale lock`); }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await fs.rmdir(lock);
    }
  });
  queues.set(storePath, next);
  try {
    return await next;
  } finally {
    if (queues.get(storePath) === next) { queues.delete(storePath); }
  }
}

/**
 * A local materialization of an Artipod root. Snapshot data is deliberately kept
 * outside the root so restore can include every entry, even ignored/.git files.
 * Stop all external writers before create/restore/fork; this is not a kernel or
 * CephFS snapshot and cannot atomically freeze terminal processes.
 */
export class ArtipodWorkspace {
  #listeners = new Set();
  #identity;

  constructor(workspacePath, storePath, rootId, identity) {
    Object.defineProperties(this, {
      workspacePath: { value: workspacePath, enumerable: true },
      storePath: { value: storePath, enumerable: true },
      rootId: { value: rootId, enumerable: true }
    });
    this.#identity = identity;
  }

  /** Open an existing directory, allocating/persisting a root ID on first use. */
  static async open({ workspacePath, storePath, rootId } = {}) {
    if (typeof workspacePath !== 'string' || typeof storePath !== 'string') { throw new TypeError('workspacePath and storePath are required'); }
    const workspace = await fs.realpath(workspacePath);
    const identity = await fs.lstat(workspace);
    if (!identity.isDirectory() || workspace === path.parse(workspace).root || workspace === await fs.realpath(os.homedir())) {
      throw new Error('Artipod requires a dedicated workspace directory, not a filesystem root or home directory');
    }
    // Check the lexical location before mkdir, then the canonical location to
    // catch symlink aliases. Reject either direction of overlap.
    const candidate = await canonicalCandidate(path.resolve(storePath));
    if (isWithin(workspace, candidate) || isWithin(candidate, workspace)) { throw new Error('Artipod store and workspace must not overlap'); }
    await fs.mkdir(candidate, { recursive: true, mode: 0o700 });
    const store = await fs.realpath(candidate);
    if (isWithin(workspace, store) || isWithin(store, workspace)) { throw new Error('Artipod store and workspace must not overlap'); }
    if (rootId !== undefined) { assertRootId(rootId); }
    return serialized(store, async () => {
      for (const directory of ['roots', 'workspaces', 'checkpoints', 'blobs']) {
        const absolute = path.join(store, directory);
        await fs.mkdir(absolute, { recursive: true });
        if (!(await fs.lstat(absolute)).isDirectory()) { throw new Error('Artipod store directories must not be symbolic links'); }
      }
      const bindingFile = path.join(store, 'workspaces', `${digest(workspace)}.json`);
      const binding = await readJson(bindingFile).catch(error => { if (error.code === 'ENOENT') { return undefined; } throw error; });
      if (binding) {
        assertRootId(binding.rootId);
        if (binding.version !== VERSION || binding.workspacePath !== workspace || (rootId && binding.rootId !== rootId)) { throw new Error('Artipod workspace root binding does not match'); }
        const root = await readJson(path.join(store, 'roots', `${binding.rootId}.json`));
        if (root.version !== VERSION || root.rootId !== binding.rootId || root.workspacePath !== workspace) { throw new Error('Artipod root metadata does not match this workspace'); }
        return new ArtipodWorkspace(workspace, store, binding.rootId, identity);
      }
      const id = rootId ?? randomUUID();
      const rootFile = path.join(store, 'roots', `${id}.json`);
      if (await exists(rootFile)) { throw new Error('Artipod root ID is already bound to another workspace'); }
      await atomicWrite(rootFile, encode({ version: VERSION, rootId: id, workspacePath: workspace }));
      await atomicWrite(bindingFile, encode({ version: VERSION, rootId: id, workspacePath: workspace }));
      return new ArtipodWorkspace(workspace, store, id, identity);
    });
  }

  /** Listener runs after a successful restore. Its errors cannot undo restore. */
  onDidRestore(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #assertWorkspace() {
    const actual = await fs.lstat(this.workspacePath);
    if (!actual.isDirectory() || actual.dev !== this.#identity.dev || actual.ino !== this.#identity.ino || await fs.realpath(this.workspacePath) !== this.workspacePath) {
      throw new Error('Artipod workspace was moved or replaced; refusing to operate');
    }
  }

  #blobPath(hash) { return path.join(this.storePath, 'blobs', hash); }
  #checkpointPath(id) { return path.join(this.storePath, 'checkpoints', `${id}.json`); }

  async #scan(persist) {
    await this.#assertWorkspace();
    const entries = [];
    const visit = async (directory, prefix) => {
      const names = (await fs.readdir(directory)).sort();
      for (const name of names) {
        const relative = prefix ? `${prefix}/${name}` : name;
        assertRelativePath(relative);
        const absolute = path.join(directory, name);
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) {
          entries.push({ path: relative, kind: 'symlink', target: await fs.readlink(absolute) });
        } else if (stat.isDirectory()) {
          entries.push({ path: relative, kind: 'directory', mode: stat.mode & 0o777 });
          await visit(absolute, relative);
        } else if (stat.isFile()) {
          // O_NOFOLLOW avoids reading a symlink swapped in after lstat. fstat
          // also catches a file changed/replaced while the snapshot is read.
          const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          let bytes;
          try {
            const before = await handle.stat();
            if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev) { throw new Error(`Workspace changed during checkpoint: ${relative}`); }
            bytes = await handle.readFile();
            const after = await handle.stat();
            if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) { throw new Error(`Workspace changed during checkpoint: ${relative}`); }
          } finally {
            await handle.close();
          }
          const hash = digest(bytes);
          if (persist) {
            const destination = this.#blobPath(hash);
            if (await exists(destination)) {
              if (digest(await fs.readFile(destination)) !== hash) { throw invalid(`corrupt existing blob ${hash}`); }
            } else {
              await atomicWrite(destination, bytes);
            }
          }
          entries.push({ path: relative, kind: 'file', mode: stat.mode & 0o777, blob: hash, size: bytes.length });
        } else {
          throw new Error(`Unsupported workspace entry (socket, FIFO or device): ${relative}`);
        }
      }
    };
    await visit(this.workspacePath, '');
    // Sorting globally rather than in traversal order gives a simple canonical
    // format across implementations, independent of filesystem enumeration.
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { version: VERSION, rootMode: (await fs.lstat(this.workspacePath)).mode & 0o777, entries };
  }

  /** Equal filesystem content/modes produces the same checkpoint ID. */
  async create({ label } = {}) {
    return serialized(this.storePath, async () => {
      const snapshot = await this.#scan(true);
      const encoded = encode(snapshot);
      const checkpointId = digest(encoded);
      const destination = this.#checkpointPath(checkpointId);
      if (await exists(destination)) {
        if (await fs.readFile(destination, 'utf8') !== encoded) { throw invalid('corrupt existing checkpoint'); }
      } else {
        await atomicWrite(destination, encoded);
      }
      return { rootId: this.rootId, checkpointId, ...(label === undefined ? {} : { label }) };
    });
  }

  async #load(checkpointId) {
    assertCheckpointId(checkpointId);
    const encoded = await fs.readFile(this.#checkpointPath(checkpointId), 'utf8');
    if (digest(encoded) !== checkpointId) { throw invalid('manifest checksum mismatch'); }
    const snapshot = JSON.parse(encoded);
    const validMode = mode => Number.isInteger(mode) && mode >= 0 && mode <= 0o777;
    if (snapshot.version !== VERSION || !validMode(snapshot.rootMode) || !Array.isArray(snapshot.entries)) { throw invalid('manifest schema'); }
    const seen = new Map();
    const blobs = new Map();
    for (const entry of snapshot.entries) {
      assertRelativePath(entry.path);
      if (seen.has(entry.path)) { throw invalid('duplicate path'); }
      seen.set(entry.path, entry);
      if (entry.kind === 'file') {
        if (!validMode(entry.mode) || !ID.test(entry.blob) || !Number.isSafeInteger(entry.size) || entry.size < 0) { throw invalid('file entry'); }
        if (!blobs.has(entry.blob)) {
          const bytes = await fs.readFile(this.#blobPath(entry.blob));
          if (digest(bytes) !== entry.blob) { throw invalid(`blob checksum mismatch ${entry.blob}`); }
          blobs.set(entry.blob, bytes);
        }
        if (blobs.get(entry.blob).length !== entry.size) { throw invalid('blob size mismatch'); }
      } else if (entry.kind === 'directory') {
        if (!validMode(entry.mode)) { throw invalid('directory mode'); }
      } else if (entry.kind === 'symlink') {
        if (typeof entry.target !== 'string' || !entry.target || entry.target.includes('\0')) { throw invalid('symlink target'); }
      } else {
        throw invalid('entry kind');
      }
    }
    for (const entry of snapshot.entries) {
      const parent = path.posix.dirname(entry.path);
      if (parent !== '.' && seen.get(parent)?.kind !== 'directory') { throw invalid(`missing/non-directory parent for ${entry.path}`); }
    }
    // Every blob and path is validated before the first workspace mutation.
    return { snapshot, blobs };
  }

  async #apply(checkpointId, loaded) {
    const { snapshot, blobs } = loaded;
    const current = await this.#scan(false);
    const before = new Map(current.entries.map(entry => [entry.path, entry]));
    const after = new Map(snapshot.entries.map(entry => [entry.path, entry]));
    const changes = [];
    for (const entry of current.entries) {
      const replacement = after.get(entry.path);
      if (!replacement || replacement.kind !== entry.kind) { changes.push({ path: entry.path, type: 'deleted', kind: entry.kind }); }
    }
    for (const entry of snapshot.entries) {
      const previous = before.get(entry.path);
      if (!previous || previous.kind !== entry.kind) { changes.push({ path: entry.path, type: 'created', kind: entry.kind }); }
      else if (encode(previous) !== encode(entry)) { changes.push({ path: entry.path, type: 'changed', kind: entry.kind }); }
    }
    if (current.rootMode !== snapshot.rootMode) { changes.push({ path: '', type: 'changed', kind: 'directory' }); }
    await this.#assertWorkspace();
    // Keep the root and unchanged directories in place so watchers remain
    // attached. Existing restrictive directories are made writable temporarily.
    await fs.chmod(this.workspacePath, current.rootMode | 0o700);
    for (const entry of current.entries.filter(entry => entry.kind === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
      await fs.chmod(path.join(this.workspacePath, entry.path), entry.mode | 0o700);
    }
    for (const entry of [...current.entries].sort((a, b) => b.path.split('/').length - a.path.split('/').length)) {
      const replacement = after.get(entry.path);
      if (!replacement || replacement.kind !== entry.kind) {
        const absolute = path.join(this.workspacePath, entry.path);
        if (entry.kind === 'directory') { await fs.rmdir(absolute); }
        else { await fs.unlink(absolute); }
      }
    }
    const directories = snapshot.entries.filter(entry => entry.kind === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length);
    for (const entry of directories) {
      const absolute = path.join(this.workspacePath, entry.path);
      if (before.get(entry.path)?.kind !== 'directory') { await fs.mkdir(absolute, { mode: 0o700 }); }
    }
    for (const entry of snapshot.entries) {
      if (entry.kind === 'directory') { continue; }
      const previous = before.get(entry.path);
      if (previous && encode(previous) === encode(entry)) { continue; }
      const absolute = path.join(this.workspacePath, entry.path);
      if (entry.kind === 'symlink') {
        if (previous?.kind === 'symlink') { await fs.unlink(absolute); }
        await fs.symlink(entry.target, absolute);
      } else {
        // Rename over an existing file rather than truncate it: hard links into
        // another root must not mutate that root when this one is restored.
        await atomicWrite(absolute, blobs.get(entry.blob));
        await fs.chmod(absolute, entry.mode);
      }
    }
    for (const entry of directories.reverse()) { await fs.chmod(path.join(this.workspacePath, entry.path), entry.mode); }
    await fs.chmod(this.workspacePath, snapshot.rootMode);
    return { rootId: this.rootId, checkpointId, changes };
  }

  /** Restore files before notifying consumers to refresh models and Explorer. */
  async restore(checkpointId) {
    const result = await serialized(this.storePath, async () => this.#apply(checkpointId, await this.#load(checkpointId)));
    for (const listener of this.#listeners) {
      try { listener(result); } catch { /* Observer failures cannot undo a restore. */ }
    }
    return result;
  }

  /** Materialize a checkpoint into a distinct empty directory with a new root. */
  async fork(checkpointId, { workspacePath, rootId } = {}) {
    // open() is deliberately outside the operation lock; apply runs under the
    // shared store lock and the destination is rechecked immediately beforehand.
    const destination = await ArtipodWorkspace.open({ workspacePath, storePath: this.storePath, rootId });
    if (destination.rootId === this.rootId || isWithin(this.workspacePath, destination.workspacePath) || isWithin(destination.workspacePath, this.workspacePath)) {
      throw new Error('Artipod fork requires a distinct, non-overlapping workspace');
    }
    await serialized(this.storePath, async () => {
      const loaded = await this.#load(checkpointId);
      if ((await fs.readdir(destination.workspacePath)).length !== 0) { throw new Error('Artipod fork destination must be empty'); }
      await destination.#apply(checkpointId, loaded);
    });
    return destination;
  }
}
