/**
 * createSandbox() — the only public entry of the sandbox core.
 *
 * Wraps a just-bash Bash instance over a ZenFsAdapter. just-bash isolates
 * state per exec() BY DESIGN (each call is "a new shell"); we reconstruct the
 * session host-side:
 *   - cwd    → recovered from result.env.PWD, passed as ExecOptions.cwd
 *   - vars / exports / aliases (BASH_ALIAS_<name>) → full env replay with
 *     replaceEnv, so `unset` also sticks
 *   - functions → known v1 limitation (just-bash does not retain function
 *     source); documented in the terminal help text
 *
 * Framework-free: no React, no Next, no window. Works in browser and Node.
 */
import { Bash } from 'just-bash/browser';
import type { CustomCommand } from 'just-bash/browser';
import { makeEditCommand } from './edit-command';
import { makeGitCommand } from './git-command';
import type { Sandbox, SandboxExecOptions, ZenFsLike } from './types';
import { ZenFsAdapter } from './zenfs-adapter';

export type { Sandbox, SandboxExecOptions, SandboxExecResult } from './types';
export { ZenFsAdapter } from './zenfs-adapter';

export interface CreateSandboxOptions {
  /** The ZenFS node-like fs object backing the sandbox. */
  zfs: ZenFsLike;
  /** Host hook for the `edit` command (opens Monaco in the browser). */
  onEdit?: (path: string) => void;
  /** Initial working directory. Default: /repo */
  cwd?: string;
  /** Additional custom commands (server may add more; agents reuse as-is). */
  extraCommands?: CustomCommand[];
}

const DEFAULT_CWD = '/repo';

export function createSandbox(opts: CreateSandboxOptions): Sandbox {
  const adapter = new ZenFsAdapter(opts.zfs);
  const initialCwd = opts.cwd ?? DEFAULT_CWD;

  const bash = new Bash({
    fs: adapter,
    cwd: initialCwd,
    env: { HOME: initialCwd, USER: 'user', TERM: 'xterm-256color' },
    customCommands: [makeGitCommand(), makeEditCommand(opts.onEdit), ...(opts.extraCommands ?? [])],
  });

  let cwd = initialCwd;
  // null until the first exec; afterwards the full env of the last line.
  let carriedEnv: Record<string, string> | null = null;

  // Interactive-shell semantics: aliases only expand with expand_aliases on,
  // and shopt state is not carried in result.env — so prepend it every line.
  const PRELUDE = 'shopt -s expand_aliases\n';

  return {
    async exec(line: string, execOpts?: SandboxExecOptions) {
      const r = await bash.exec(PRELUDE + line, {
        cwd,
        ...(carriedEnv ? { env: carriedEnv, replaceEnv: true } : {}),
        ...(execOpts?.signal ? { signal: execOpts.signal } : {}),
      });
      if (!execOpts?.transient) {
        if (r.env) carriedEnv = r.env;
        if (r.env?.PWD) cwd = r.env.PWD;
      }
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    },
    getCwd: () => cwd,
    getEnv: () => carriedEnv ?? {},
    fs: adapter,
  };
}
