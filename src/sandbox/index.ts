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
import type { BashOptions, CustomCommand } from 'just-bash/browser';
import { createGitOps } from './git.js';
import { reconcileProc } from '../proc/reconcile.js';
import { refreshProc } from '../proc/snapshot.js';
import { registerBuiltinProviders } from '../proc/storage-provider.js';
import { makeEditCommand } from './edit-command.js';
import { makeGitCommand } from './git-command.js';
import { makeModuleCommands } from './module-command.js';
import { makeNotesCommand } from './notes-command.js';
import { makeStorageCommands } from './storage-command.js';
import { makeSudoCommand } from './sudo-command.js';
import type { PodEvents } from '../events.js';
import type { CompletionResult, Sandbox, SandboxExecOptions, ZenFsLike } from './types.js';
import { ZenFsAdapter } from './zenfs-adapter.js';

export type { CompletionResult, Sandbox, SandboxExecOptions, SandboxExecResult, ZenFsLike } from './types.js';
export { SHELL_NOTES } from './notes-command.js';
export { ZenFsAdapter } from './zenfs-adapter.js';
export { SUDO_DENIED_MESSAGE } from './sudo-command.js';
// App-facing sandbox infrastructure: storage backends, git ops + auth.
export * from './storage.js';
export { createGitOps, getAuthor, setAuthor, setCorsProxy, getCorsProxy } from './git.js';
export type { GitOps, GitStatusResult, StatusEntry } from './git.js';
export {
  setAuthPrompt,
  persistenceEnabled,
  setPersistence,
  setToken,
  getToken,
  clearToken,
  onAuthForUrl,
  onAuthFailureForUrl,
} from './git-auth.js';

export interface CreateSandboxOptions {
  /** The ZenFS node-like fs object backing the sandbox. */
  zfs: ZenFsLike;
  /** Host hook for the `edit` command (opens Monaco in the browser). */
  onEdit?: (path: string) => void;
  /** Pod event bus: exec:start/exec:end, coarse fs:changed, edit:request, approval:request. */
  events?: PodEvents;
  /** Initial working directory. Default: /repo */
  cwd?: string;
  /** Additional custom commands (server may add more; agents reuse as-is). */
  extraCommands?: CustomCommand[];
  /**
   * Mount `/proc` and add lsmod/modinfo/modprobe: the snapshot is rebuilt from
   * the registered providers before every command and reconciled after it.
   */
  proc?: boolean;
  /**
   * Host work to run around each non-transient command, e.g. materializing
   * state into the filesystem. Returned messages are appended to stderr, so a
   * hook reports a problem without taking the command down.
   */
  hooks?: {
    beforeExec?: () => Promise<string[] | void> | string[] | void;
    afterExec?: () => Promise<string[] | void> | string[] | void;
  };
  /** Tighter limits for server / agent use (defaults are sane for humans). */
  executionLimits?: BashOptions['executionLimits'];
  executionLimitProfile?: BashOptions['executionLimitProfile'];
  /** Phase 6.5 approval flow for `sudo`; absent = default-deny stub. */
  sudo?: import('./sudo-command.js').SudoOptions;
}

const DEFAULT_CWD = '/repo';

export function createSandbox(opts: CreateSandboxOptions): Sandbox {
  const adapter = new ZenFsAdapter(opts.zfs);
  const initialCwd = opts.cwd ?? DEFAULT_CWD;
  if (opts.proc) registerBuiltinProviders();

  const bash = new Bash({
    fs: adapter,
    cwd: initialCwd,
    env: {
      HOME: initialCwd,
      USER: 'user',
      TERM: 'xterm-256color',
      // no TTY — pagers degrade to cat; ordinary aliases, so unalias/redefine work
      BASH_ALIAS_less: 'cat',
      BASH_ALIAS_more: 'cat',
    },
    executionLimits: opts.executionLimits,
    executionLimitProfile: opts.executionLimitProfile,
    customCommands: [
      // git shares the sandbox's zfs — shell view and git view stay coherent
      makeGitCommand(createGitOps(() => opts.zfs)),
      makeEditCommand(opts.onEdit, opts.events),
      makeNotesCommand(),
      makeSudoCommand(opts.events, opts.sudo),
      ...makeStorageCommands(() => opts.zfs),
      ...(opts.proc ? makeModuleCommands() : []),
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
      // Transient execs (tab completion) must not disturb the snapshot.
      const live = !execOpts?.transient;
      const notices: string[] = [];
      const startedAt = Date.now();
      if (live) {
        opts.events?.emit('exec:start', { line });
        notices.push(...((await opts.hooks?.beforeExec?.()) ?? []));
        if (opts.proc) notices.push(...(await refreshProc(opts.zfs)));
        history.push(line);
      }
      const r = await runLine(line, execOpts);
      if (live) {
        if (r.env) {
          const { BASH_HISTORY: _history, ...rest } = r.env;
          carriedEnv = rest;
        }
        if (r.env?.PWD) cwd = r.env.PWD;
        if (opts.proc) notices.push(...(await reconcileProc(opts.zfs)));
        notices.push(...((await opts.hooks?.afterExec?.()) ?? []));
        opts.events?.emit('exec:end', { line, exitCode: r.exitCode, durationMs: Date.now() - startedAt });
        // Coarse by contract: a shell line can touch anything.
        opts.events?.emit('fs:changed', { origin: 'exec' });
      }
      const stderr = notices.length ? `${r.stderr}${notices.join('\n')}\n` : r.stderr;
      return { stdout: r.stdout, stderr, exitCode: r.exitCode };
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
    zfs: opts.zfs,
  };
  return sandbox;
}

const splitLines = (s: string) => s.split('\n').filter(Boolean);

/** Single-quote a string for safe embedding in a bash line. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
