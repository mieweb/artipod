/**
 * Shared types for the sandbox core.
 *
 * This module (and everything under lib/sandbox/) must stay framework-free:
 * no React, no Next, no `window` at module top level. Type-only imports of
 * @zenfs/core are erased at compile time, so this works in browser and Node.
 */

/** The node-like ZenFS `fs` object (or a bound context with the same shape). */
export type ZenFsLike = (typeof import('@zenfs/core'))['fs'];

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxExecOptions {
  /** Cooperative cancellation (Ctrl+C, agent abort). */
  signal?: AbortSignal;
  /**
   * When true, the result's env/cwd are NOT absorbed into the session.
   * Used for hidden helper execs (e.g. tab-completion via compgen).
   */
  transient?: boolean;
}

export interface Sandbox {
  exec(line: string, opts?: SandboxExecOptions): Promise<SandboxExecResult>;
  getCwd(): string;
  /** The carried session environment (vars, exports, BASH_ALIAS_* entries). */
  getEnv(): Readonly<Record<string, string>>;
  fs: import('./zenfs-adapter').ZenFsAdapter;
}
