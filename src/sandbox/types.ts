/**
 * Shared types for the sandbox core.
 *
 * This module (and everything under lib/sandbox/) must stay framework-free:
 * no React, no Next, no `window` at module top level. Type-only imports of
 * @zenfs/core are erased at compile time, so this works in browser and Node.
 */

/** The node-like ZenFS `fs` object (or a bound context with the same shape). */
export type ZenFsLike = (typeof import('@zenfs/core'))['fs'];

/**
 * Sub-verb completion for a custom command: `args` are the words already
 * typed after the command name, `token` the (possibly empty) word being
 * completed. Return every candidate; the sandbox filters by prefix.
 */
export type Completer = (args: string[], token: string) => string[] | Promise<string[]>;

export type CompletableCommand = import('just-bash/browser').CustomCommand & { complete?: Completer };

/** Attach sub-verb completion to a just-bash custom command. */
export const withCompletion = <C extends import('just-bash/browser').CustomCommand>(command: C, complete: Completer): C & { complete: Completer } =>
  Object.assign(command, { complete });

/** A completer for a fixed verb tree: `{ image: { pull: {}, ls: {} }, ps: {} }`. */
export const verbTree = (tree: Record<string, unknown>): Completer => (args) => {
  let node: unknown = tree;
  for (const word of args) {
    if (!node || typeof node !== 'object' || !(word in (node as object))) return [];
    node = (node as Record<string, unknown>)[word];
  }
  return node && typeof node === 'object' ? Object.keys(node as object) : [];
};

/**
 * What this shell is a shell *of*. Drives `hostname`, `uname -a`, the prompt
 * and the banner so a user can always tell a catalog console from a pod
 * workspace from a server exec session.
 */
export interface SandboxIdentity {
  /** `catalog` (no pod), `workspace` (a pod session), `server` (an exec session), … */
  kind: string;
  /** Human label: the ref, workspace id, or session id. */
  name: string;
  /** e.g. `cow` / `rw` / `ro` for workspaces. */
  mode?: string;
  /** The artipod version string shown by `uname -r` and the banner. */
  version?: string;
}

/** `samples/lifecycle:_3` → `samples_lifecycle__3`: the hostname form of a name. */
export const hostnameOf = (identity: SandboxIdentity): string =>
  identity.kind === 'catalog' ? 'catalog' : identity.name.replace(/[^a-zA-Z0-9._-]+/g, '_');

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxExecOptions {
  /** Cooperative cancellation (Ctrl+C, agent abort). */
  signal?: AbortSignal;
  /**
   * When true, the result's env/cwd are NOT absorbed into the session and
   * the line is not recorded in history. Used for hidden helper execs
   * (e.g. tab-completion via compgen).
   */
  transient?: boolean;
}

export interface CompletionResult {
  /** Sorted unique candidates; directories carry a trailing `/`. */
  candidates: string[];
  /** Index in the input line where the token being completed starts. */
  replaceStart: number;
}

export interface Sandbox {
  exec(line: string, opts?: SandboxExecOptions): Promise<SandboxExecResult>;
  getCwd(): string;
  /** The carried session environment (vars, exports, BASH_ALIAS_* entries). */
  getEnv(): Readonly<Record<string, string>>;
  /** Tab-completion for an input line (commands, aliases, paths). */
  complete(line: string): Promise<CompletionResult>;
  /**
   * Names of the registered custom commands (git, edit, notes, …). The
   * just-bash `help` builtin lists only builtins, so hosts surface these
   * separately (TerminalSession appends them to `help`).
   */
  customCommands: string[];
  fs: import('./zenfs-adapter.js').ZenFsAdapter;
  /** The raw node-like fs backing the sandbox (same store as `fs`). */
  zfs: ZenFsLike;
  /** Retire this shell: removes its row from the process table. Idempotent. */
  dispose(): void;
  /** What this shell is a shell of, when the host said. */
  identity?: SandboxIdentity;
}
