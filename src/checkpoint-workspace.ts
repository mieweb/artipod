import { fork as spawnWorker } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Checkpoint {
  /** The actual podId from .artipod/superblock.json, stable across reopen. */
  rootId: string;
  /** A persisted Artipod SnapshotManager ID (snap-…), not a content digest. */
  checkpointId: string;
  label?: string;
}
export interface CheckpointInfo extends Checkpoint {
  /** Persisted snapshot creation time in ISO 8601 format. */
  createdAt: string;
  parentCheckpointId: string | null;
  origin: 'manual' | 'agent-turn' | 'compact';
  /** Whether this snapshot is the pod's current history HEAD. */
  isHead: boolean;
}
export interface RestoreChange {
  /** Relative POSIX path; an empty path identifies the root directory mode. */
  path: string;
  type: 'created' | 'changed' | 'deleted';
  kind: 'file' | 'directory' | 'symlink';
}
export interface RestoreResult extends Checkpoint { changes: RestoreChange[] }

const queues = new Map<string, Promise<unknown>>();
const within = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const validRoot = (id: string) => { if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('Invalid Artipod root ID'); };
const validCheckpoint = (id: string) => { if (!/^snap-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid Artipod checkpoint ID'); };

async function canonicalCandidate(candidate: string): Promise<string> {
  try { return await fs.realpath(candidate); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(await canonicalCandidate(parent), path.basename(candidate));
  }
}

async function assertDedicatedWorkspace(directory: string, identity: { isDirectory(): boolean }): Promise<void> {
  if (!identity.isDirectory() || directory === path.parse(directory).root || directory === await fs.realpath(os.homedir())) {
    throw new Error('Artipod requires a dedicated workspace directory, not a filesystem root or home directory');
  }
}

/** Reject metadata paths that could redirect OCI writes outside this pod. */
export async function assertSafeCheckpointMetadata(workspacePath: string): Promise<void> {
  const visit = async (entry: string): Promise<void> => {
    const stat = await fs.lstat(entry).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))) {
      throw new Error(`Unsafe Artipod checkpoint metadata: ${entry}; symlinks, hardlinks and special files are unsupported`);
    }
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(entry)) await visit(path.join(entry, name));
    }
  };
  await visit(path.join(workspacePath, '.artipod'));
}

async function assertDirectoryIdentity(directory: string, expected: { dev: number; ino: number }): Promise<void> {
  const actual = await fs.lstat(directory);
  if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino || await fs.realpath(directory) !== directory) {
    throw new Error('Artipod fork destination was moved or replaced; refusing to operate');
  }
}

/** Keep this mutex outside the captured root, including while its mode changes. */
async function withWorkspaceLock<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
  const uid = process.getuid?.();
  const user = uid === undefined ? createHash('sha256').update(os.homedir()).digest('hex') : String(uid);
  const directory = path.join(await fs.realpath(os.tmpdir()), `artipod-checkpoints-${user}`);
  if (within(workspacePath, directory)) throw new Error('Artipod workspace must not contain the shared temporary checkpoint lock directory');
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const identity = await fs.lstat(directory);
  const assertPrivateDirectory = async () => {
    const actual = await fs.lstat(directory);
    if (!actual.isDirectory() || actual.dev !== identity.dev || actual.ino !== identity.ino || await fs.realpath(directory) !== directory ||
      (uid !== undefined && (actual.uid !== uid || (actual.mode & 0o777) !== 0o700))) {
      throw new Error(`Unsafe Artipod checkpoint lock directory: ${directory}; requires a private directory owned by the current user`);
    }
  };
  await assertPrivateDirectory();
  const lock = path.join(directory, createHash('sha256').update(workspacePath).digest('hex'));
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Artipod checkpoint store is busy (${lock}); stop its owner before removing a stale lock`);
    throw error;
  }
  const lockIdentity = await fs.lstat(lock);
  const release = async () => {
    await assertPrivateDirectory();
    const actual = await fs.lstat(lock);
    if (!actual.isDirectory() || actual.dev !== lockIdentity.dev || actual.ino !== lockIdentity.ino || await fs.realpath(lock) !== lock) {
      throw new Error(`Artipod checkpoint lock was moved or replaced: ${lock}`);
    }
    await fs.rmdir(lock);
  };
  try { return await operation(); }
  finally { await release(); }
}

async function serialized<T>(workspacePath: string, operation: () => Promise<T>, afterUnlock?: (result: T) => Promise<void>): Promise<T> {
  const previous = queues.get(workspacePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => withWorkspaceLock(workspacePath, async () => {
    await assertSafeCheckpointMetadata(workspacePath);
    const metadata = path.join(workspacePath, '.artipod');
    await fs.mkdir(metadata, { recursive: true });
    if (!(await fs.lstat(metadata)).isDirectory()) throw new Error('Artipod metadata must be a real directory');
    const lock = path.join(metadata, 'checkpoint-lock');
    try { await fs.mkdir(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Artipod checkpoint store is busy (${lock}); stop its owner before removing a stale lock`);
      throw error;
    }
    let result: T;
    try { result = await operation(); }
    finally { await fs.rmdir(lock); }
    await afterUnlock?.(result);
    return result;
  }));
  queues.set(workspacePath, next);
  try { return await next; }
  finally { if (queues.get(workspacePath) === next) queues.delete(workspacePath); }
}

function worker<T>(message: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawnWorker(fileURLToPath(new URL('./checkpoint-worker.js', import.meta.url)), [], {
      execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    let response: { result?: T; error?: string } | undefined;
    child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-8000); });
    child.once('message', value => { response = value as typeof response; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (response?.error) reject(new Error(response.error));
      else if (code !== 0 || !response || !('result' in response)) reject(new Error(`Artipod worker failed (${code ?? signal}): ${stderr}`));
      else resolve(response.result as T);
    });
    child.send(message);
  });
}

/** Local Artipod root, sharing the CLI's superblock and OCI snapshot history. */
export class ArtipodWorkspace {
  readonly workspacePath: string;
  readonly storePath: string;
  readonly rootId: string;
  #identity: { dev: number; ino: number };
  #listeners = new Set<(result: RestoreResult) => void>();
  private constructor(workspacePath: string, storePath: string, rootId: string, identity: { dev: number; ino: number }) {
    this.workspacePath = workspacePath; this.storePath = storePath; this.rootId = rootId; this.#identity = identity;
  }

  /** storePath holds caller mappings; actual snapshot bytes live in .artipod. */
  static async open(options: { workspacePath: string; storePath: string; rootId?: string }): Promise<ArtipodWorkspace> {
    const workspacePath = await fs.realpath(options.workspacePath);
    const identity = await fs.lstat(workspacePath);
    await assertDedicatedWorkspace(workspacePath, identity);
    const storePath = await canonicalCandidate(path.resolve(options.storePath));
    if (within(workspacePath, storePath) || within(storePath, workspacePath)) throw new Error('Artipod store and workspace must not overlap');
    await fs.mkdir(storePath, { recursive: true });
    if (options.rootId) validRoot(options.rootId);
    const result = await serialized(workspacePath, () => worker<{ rootId: string }>({ operation: 'open', workspacePath, rootId: options.rootId }));
    return new ArtipodWorkspace(workspacePath, storePath, result.rootId, identity);
  }

  async #assertWorkspace(): Promise<void> {
    const actual = await fs.lstat(this.workspacePath);
    if (!actual.isDirectory() || actual.dev !== this.#identity.dev || actual.ino !== this.#identity.ino || await fs.realpath(this.workspacePath) !== this.workspacePath) throw new Error('Artipod workspace was moved or replaced; refusing to operate');
  }
  async #operate<T>(operation: string, options: Record<string, unknown> = {}, afterUnlock?: (result: T) => Promise<void>): Promise<T> {
    await this.#assertWorkspace();
    return serialized(this.workspacePath, async () => {
      await this.#assertWorkspace();
      return worker<T>({ ...options, operation, workspacePath: this.workspacePath, rootId: this.rootId });
    }, afterUnlock);
  }
  /** Stop external writers first. Captures all paths except /.artipod and /proc. */
  create(options: { label?: string; origin?: 'manual' | 'agent-turn' } = {}): Promise<Checkpoint> { return this.#operate('create', options); }
  /** Persisted snapshot metadata, oldest first; includes history retained after restore. */
  list(): Promise<CheckpointInfo[]> { return this.#operate('list'); }
  async restore(checkpointId: string): Promise<RestoreResult> {
    validCheckpoint(checkpointId);
    const { rootId, changes } = await this.#operate<RestoreResult & { rootMode: number }>('restore', { checkpointId }, async restored => {
      // A captured root can remove search permission. Finish lock bookkeeping
      // before applying its mode, while retaining the queue and external lock.
      await this.#assertWorkspace();
      await fs.chmod(this.workspacePath, restored.rootMode);
    });
    const result: RestoreResult = { rootId, checkpointId, changes };
    for (const listener of this.#listeners) { try { listener(result); } catch { /* restored state is committed */ } }
    return result;
  }
  /** Fork into an existing empty directory, preserving source snapshot IDs. */
  async fork(checkpointId: string, options: { workspacePath: string; rootId?: string }): Promise<ArtipodWorkspace> {
    validCheckpoint(checkpointId);
    if (options.rootId) validRoot(options.rootId);
    if (options.rootId === this.rootId) throw new Error('Artipod fork requires a distinct root ID');
    const destination = await fs.realpath(options.workspacePath);
    const destinationIdentity = await fs.lstat(destination);
    await assertDedicatedWorkspace(destination, destinationIdentity);
    if (within(this.workspacePath, destination) || within(destination, this.workspacePath) || within(destination, this.storePath) || within(this.storePath, destination)) throw new Error('Artipod fork requires distinct non-overlapping workspace paths');
    await this.#assertWorkspace();
    const result = await serialized(this.workspacePath, () => withWorkspaceLock(destination, async () => {
      await this.#assertWorkspace();
      await assertDirectoryIdentity(destination, destinationIdentity);
      if ((await fs.readdir(destination)).length) throw new Error('Artipod fork destination must be empty');
      // Retain the in-pod reservation for older callers. The external destination
      // lock spans this cleanup and the final chmod, even for mode 000 roots.
      const metadata = path.join(destination, '.artipod');
      try { await fs.mkdir(metadata); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Artipod fork destination is already reserved or non-empty');
        throw error;
      }
      const lock = path.join(metadata, 'checkpoint-lock');
      await fs.mkdir(lock);
      let forked: { rootId: string; rootMode: number };
      try {
        await assertDirectoryIdentity(destination, destinationIdentity);
        forked = await worker<{ rootId: string; rootMode: number }>({
          operation: 'fork', workspacePath: this.workspacePath, rootId: this.rootId,
          checkpointId, destination, destinationRootId: options.rootId,
          destinationIdentity: { dev: destinationIdentity.dev, ino: destinationIdentity.ino },
        });
      } finally {
        await fs.rmdir(lock);
        // Leave partial runtime metadata for inspection if a fork failed after
        // initialization; never recursively delete a caller-owned directory.
        await fs.rmdir(metadata).catch(error => {
          if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        });
      }
      await assertDirectoryIdentity(destination, destinationIdentity);
      await fs.chmod(destination, forked.rootMode);
      return forked;
    }));
    return new ArtipodWorkspace(destination, this.storePath, result.rootId, destinationIdentity);
  }
  onDidRestore(listener: (result: RestoreResult) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  /** A fresh real Artipod interpreted shell command in this persistent pod. */
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> { return this.#operate('exec', { command }); }
}
