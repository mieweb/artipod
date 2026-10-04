export interface Checkpoint {
  /** Persisted identity for this materialized workspace, stable across reopen. */
  rootId: string;
  /** SHA-256 of canonical manifest; identical content and modes share this ID. */
  checkpointId: string;
  /** An optional caller label, returned unchanged, not part of the content ID. */
  label?: string;
}

export interface RestoreChange {
  /** POSIX relative path. Empty string means the root directory mode changed. */
  path: string;
  type: 'created' | 'changed' | 'deleted';
  kind: 'file' | 'directory' | 'symlink';
}

export interface RestoreResult extends Checkpoint {
  /** Type replacement emits deleted(old kind) and created(new kind). */
  changes: RestoreChange[];
}

export declare class ArtipodWorkspace {
  private constructor();
  readonly workspacePath: string;
  readonly storePath: string;
  readonly rootId: string;

  /** Workspace must exist. Store must not overlap it, even through symlinks. */
  static open(options: {
    workspacePath: string;
    storePath: string;
    rootId?: string;
  }): Promise<ArtipodWorkspace>;

  /** Quiesce terminal/background writers first. Includes ignored and .git files. */
  create(options?: { label?: string }): Promise<Checkpoint>;

  /** Validate the complete snapshot before mutating the materialized workspace. */
  restore(checkpointId: string): Promise<RestoreResult>;

  /** Destination must already exist, be empty, and not overlap the source. */
  fork(checkpointId: string, options: {
    workspacePath: string;
    rootId?: string;
  }): Promise<ArtipodWorkspace>;

  /** Called after successful restore. Returns a listener removal function. */
  onDidRestore(listener: (result: RestoreResult) => void): () => void;
}
