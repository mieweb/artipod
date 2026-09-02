/**
 * TerminalSession — the headless terminal line discipline extracted from
 * artipod-sync's Terminal.tsx (plan §3): input buffer, history, common-prefix
 * tab completion, Ctrl+C abort, prompt-from-cwd, \n→\r\n normalization.
 *
 * I/O contract: `handleData(data)` in, `io.write(text)` out — anything
 * xterm-shaped satisfies it; tests use a fake. No DOM at module top level.
 */
import type { Sandbox } from '../sandbox/types.js';
import type { PodEvents } from '../events.js';

export interface TerminalIO {
  write(text: string): void;
}

export interface TerminalSessionOptions {
  sandbox: Sandbox;
  io: TerminalIO;
  /** Agent tool-call echo arrives via events (replaces registerWriter). */
  events?: PodEvents;
  /** Lines written once on attach (app-owned banner). */
  banner?: string[];
  /**
   * Shown by `help` above the builtin list (just-bash's help builtin cannot
   * be shadowed, so the line discipline prepends it). E.g. "0.7.1".
   */
  version?: string;
  /** Secondary tabs: refuse to run commands, explain why. */
  readOnly?: boolean;
}

const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** xterm wants \r\n; sandbox output uses \n. */
export const toCrLf = (s: string): string => s.replace(/\r?\n/g, '\r\n');

/** Longest common prefix of a non-empty candidate list. */
export function commonPrefix(items: string[]): string {
  let prefix = items[0];
  for (const item of items.slice(1)) {
    while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

export class TerminalSession {
  private buffer = '';
  private history: string[] = [];
  private historyIndex = 0;
  private busy = false;
  private abortController: AbortController | null = null;
  private completing = false;
  private disposers: Array<() => void> = [];
  private disposed = false;

  constructor(private readonly opts: TerminalSessionOptions) {
    const { io, banner, events } = opts;
    if (banner?.length) {
      for (const line of banner) io.write(`${line}\r\n`);
    }
    if (events) {
      this.disposers.push(
        events.on('agent:tool-call', (e) => {
          if (e.phase === 'call') {
            const args = e.arguments.length > 120 ? `${e.arguments.slice(0, 120)}…` : e.arguments;
            io.write(`\r\n${DIM}⚙ ${e.name} ${args}${RESET}\r\n`);
          } else if (e.summary) {
            io.write(`${DIM}${toCrLf(e.summary)}${RESET}`);
          }
        }),
      );
    }
    this.prompt();
  }

  /** The shell prompt string (cwd-derived, like the app's getPrompt). */
  private promptText(): string {
    return `${this.opts.sandbox.getCwd()} $ `;
  }

  prompt(): void {
    this.opts.io.write(`\r\n${this.promptText()}`);
  }

  private redrawLine(): void {
    this.opts.io.write(`${this.promptText()}${this.buffer}`);
  }

  private eraseBuffer(): void {
    while (this.buffer.length > 0) {
      this.opts.io.write('\b \b');
      this.buffer = this.buffer.slice(0, -1);
    }
  }

  /** Feed raw terminal input (keystrokes, paste). */
  async handleData(data: string): Promise<void> {
    if (this.disposed) return;
    const { io, sandbox } = this.opts;

    // Ctrl+C first: must work while a command is running.
    if (data === '\x03') {
      if (this.busy) {
        this.abortController?.abort();
      } else {
        io.write('^C');
        this.buffer = '';
        this.prompt();
      }
      return;
    }
    if (this.busy) return; // ignore typing while a command runs
    const code = data.charCodeAt(0);

    if (data === '\t') {
      if (this.completing || !this.buffer) return;
      this.completing = true;
      try {
        const { candidates, replaceStart } = await sandbox.complete(this.buffer);
        if (candidates.length === 0) return;
        const token = this.buffer.slice(replaceStart);
        if (candidates.length === 1) {
          const chosen = candidates[0];
          const suffix = chosen.endsWith('/') ? '' : ' ';
          const insert = chosen.slice(token.length) + suffix;
          this.buffer += insert;
          io.write(insert);
        } else {
          const lcp = commonPrefix(candidates);
          if (lcp.length > token.length) {
            const insert = lcp.slice(token.length);
            this.buffer += insert;
            io.write(insert);
          } else {
            const shown = candidates.slice(0, 60);
            const more = candidates.length - shown.length;
            io.write(`\r\n${DIM}${shown.join('  ')}${more > 0 ? `  …+${more}` : ''}${RESET}\r\n`);
            this.redrawLine();
          }
        }
      } finally {
        this.completing = false;
      }
      return;
    }

    if (data === '\x1b[A') {
      // Up arrow
      if (this.historyIndex > 0) {
        this.eraseBuffer();
        this.historyIndex--;
        const prev = this.history[this.historyIndex];
        io.write(prev);
        this.buffer = prev;
      }
      return;
    }

    if (data === '\x1b[B') {
      // Down arrow
      if (this.historyIndex < this.history.length) {
        this.eraseBuffer();
        this.historyIndex++;
        if (this.historyIndex === this.history.length) {
          this.buffer = '';
        } else {
          const next = this.history[this.historyIndex];
          io.write(next);
          this.buffer = next;
        }
      }
      return;
    }

    if (code === 13) {
      // Enter
      io.write('\r\n');
      const cmd = this.buffer;
      this.buffer = '';

      if (cmd.trim()) {
        if (this.opts.readOnly) {
          io.write(`${RED}read-only session: commands are disabled in this tab${RESET}\r\n`);
          this.prompt();
          return;
        }
        this.history.push(cmd);
        this.historyIndex = this.history.length;

        this.busy = true;
        this.abortController = new AbortController();
        try {
          if (this.opts.version && /^help(\s|$)/.test(cmd.trim())) {
            io.write(`${DIM}artipod @artipod/core ${this.opts.version}${RESET}\r\n`);
          }
          if (/^help$/.test(cmd.trim()) && sandbox.customCommands.length > 0) {
            // just-bash's help lists builtins only — surface the extras here
            io.write(`${DIM}artipod extras: ${[...sandbox.customCommands].sort().join(', ')} (details: notes)${RESET}\r\n\r\n`);
          }
          const result = await sandbox.exec(cmd, { signal: this.abortController.signal });
          if (result.stdout) io.write(toCrLf(result.stdout));
          if (result.stderr) io.write(`${RED}${toCrLf(result.stderr)}${RESET}`);
        } catch (e) {
          io.write(`${RED}${toCrLf(String(e))}${RESET}\r\n`);
        } finally {
          this.busy = false;
          this.abortController = null;
        }
      }
      this.prompt();
    } else if (code === 127) {
      // Backspace
      if (this.buffer.length > 0) {
        this.buffer = this.buffer.slice(0, -1);
        this.opts.io.write('\b \b');
      }
    } else if (code < 32) {
      // Ignore other control characters
    } else {
      this.buffer += data;
      this.opts.io.write(data);
    }
  }

  get isBusy(): boolean {
    return this.busy;
  }

  dispose(): void {
    this.disposed = true;
    this.abortController?.abort();
    for (const d of this.disposers.splice(0)) d();
  }
}
