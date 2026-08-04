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
import { makeNotesCommand } from './notes-command';
import type { CompletionResult, Sandbox, SandboxExecOptions, ZenFsLike } from './types';
import { ZenFsAdapter } from './zenfs-adapter';

export type { CompletionResult, Sandbox, SandboxExecOptions, SandboxExecResult } from './types';
export { SHELL_NOTES } from './notes-command';
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
    customCommands: [
      makeGitCommand(),
      makeEditCommand(opts.onEdit),
      makeNotesCommand(),
      ...(opts.extraCommands ?? []),
    ],
  });

  let cwd = initialCwd;
  // null until the first exec; afterwards the full env of the last line.
  let carriedEnv: Record<string, string> | null = null;
  // Mirrored into BASH_HISTORY (JSON array) so the `history` builtin works.
  const history: string[] = [];

  // Interactive-shell semantics: aliases only expand with expand_aliases on,
  // and shopt state is not carried in result.env — so prepend it every line.
  const PRELUDE = 'shopt -s expand_aliases\n';

  const runLine = (line: string, execOpts?: SandboxExecOptions) =>
    bash.exec(PRELUDE + line, {
      cwd,
      env: { ...(carriedEnv ?? {}), BASH_HISTORY: JSON.stringify(history) },
      ...(carriedEnv ? { replaceEnv: true } : {}),
      ...(execOpts?.signal ? { signal: execOpts.signal } : {}),
    });

  const sandbox: Sandbox = {
    async exec(line: string, execOpts?: SandboxExecOptions) {
      if (!execOpts?.transient) history.push(line);
      const r = await runLine(line, execOpts);
      if (!execOpts?.transient) {
        if (r.env) {
          const { BASH_HISTORY: _history, ...rest } = r.env;
          carriedEnv = rest;
        }
        if (r.env?.PWD) cwd = r.env.PWD;
      }
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    },

    getCwd: () => cwd,
    getEnv: () => carriedEnv ?? {},

    async complete(line: string): Promise<CompletionResult> {
      const tokenMatch = line.match(/[^\s]*$/);
      const token = tokenMatch ? tokenMatch[0] : '';
      const replaceStart = line.length - token.length;
      if (!token) return { candidates: [], replaceStart };

      const before = line.slice(0, replaceStart).trimEnd();
      const isCommandPos =
        before === '' || /[|;&(]$|\$\($|&&$|\|\|$/.test(before) || before.endsWith('`');

      const q = shQuote(token);
      const script =
        isCommandPos && !token.includes('/')
          ? `compgen -A command ${q}; compgen -A alias ${q}; compgen -d ${q}`
          : `compgen -f ${q}; compgen -d ${q}`;

      const r = await this.exec(script, { transient: true });
      const dirCheck = await this.exec(`compgen -d ${q}`, { transient: true });
      const dirs = new Set(splitLines(dirCheck.stdout));

      const candidates = Array.from(new Set(splitLines(r.stdout)))
        .sort()
        .map((c) => (dirs.has(c) ? `${c}/` : c));
      return { candidates, replaceStart };
    },

    fs: adapter,
  };
  return sandbox;
}

const splitLines = (s: string) => s.split('\n').filter(Boolean);

/** Single-quote a string for safe embedding in a bash line. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
