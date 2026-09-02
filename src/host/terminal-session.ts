/**
 * TerminalSession — the headless terminal line discipline extracted from
 * artipod-sync's Terminal.tsx (plan §3): input buffer, history, common-prefix
 * tab completion, readline-style cursor editing (Ctrl+A/E, ←/→, Delete,
 * mid-line insert/backspace), Ctrl+R reverse search, Ctrl+C abort,
 * prompt-from-cwd, \n→\r\n normalization.
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

interface ReverseSearch {
  query: string;
  /** History index of the current match, -1 while nothing matches. */
  matchIndex: number;
  /** Line to restore when the search is cancelled. */
  savedBuffer: string;
}

export class TerminalSession {
  private buffer = '';
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = 0;
  private search: ReverseSearch | null = null;
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

  /** Replace the visible line in place (history recall, search exit). */
  private setLine(text: string): void {
    this.buffer = text;
    this.cursor = text.length;
    this.opts.io.write(`\r\x1b[K${this.promptText()}${text}`);
  }

  /** Newest history entry at or before `from` containing `query`, or -1. */
  private findMatch(query: string, from: number): number {
    if (!query) return -1;
    for (let i = Math.min(from, this.history.length - 1); i >= 0; i--) {
      if (this.history[i].includes(query)) return i;
    }
    return -1;
  }

  private renderSearch(): void {
    const s = this.search!;
    const match = s.matchIndex >= 0 ? this.history[s.matchIndex] : '';
    const label = s.query && s.matchIndex < 0 ? 'failing reverse-i-search' : 'reverse-i-search';
    this.opts.io.write(`\r\x1b[K(${label})\`${s.query}': ${match}`);
  }

  private exitSearch(adopt: boolean): void {
    const s = this.search!;
    this.search = null;
    this.setLine(adopt && s.matchIndex >= 0 ? this.history[s.matchIndex] : s.savedBuffer);
  }

  /** Returns true when the key should continue into normal handling (Enter). */
  private handleSearchKey(data: string): boolean {
    const s = this.search!;
    if (data === '\r') {
      this.exitSearch(true);
      return true;
    }
    if (data === '\x12') {
      // step to the next-older match
      const from = s.matchIndex >= 0 ? s.matchIndex - 1 : this.history.length - 1;
      const idx = this.findMatch(s.query, from);
      if (idx >= 0) s.matchIndex = idx;
      this.renderSearch();
      return false;
    }
    if (data.charCodeAt(0) === 127) {
      s.query = s.query.slice(0, -1);
      s.matchIndex = this.findMatch(s.query, this.history.length - 1);
      this.renderSearch();
      return false;
    }
    if (data.charCodeAt(0) < 32) {
      // Esc, arrows, Tab, other controls: adopt the match and leave search
      this.exitSearch(true);
      return false;
    }
    s.query += data;
    s.matchIndex = this.findMatch(s.query, s.matchIndex >= 0 ? s.matchIndex : this.history.length - 1);
    this.renderSearch();
    return false;
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
        this.search = null;
        io.write('^C');
        this.buffer = '';
        this.cursor = 0;
        this.prompt();
      }
      return;
    }
    if (this.busy) return; // ignore typing while a command runs

    if (this.search) {
      if (!this.handleSearchKey(data)) return;
      // Enter adopted the match into the buffer — fall through to execute it.
    }
    const code = data.charCodeAt(0);

    if (data === '\x12') {
      // Ctrl+R: reverse history search
      this.search = { query: '', matchIndex: -1, savedBuffer: this.buffer };
      this.renderSearch();
      return;
    }

    if (data === '\x01' || data === '\x1b[H' || data === '\x1b[1~') {
      // Ctrl+A / Home
      if (this.cursor > 0) io.write(`\x1b[${this.cursor}D`);
      this.cursor = 0;
      return;
    }

    if (data === '\x05' || data === '\x1b[F' || data === '\x1b[4~') {
      // Ctrl+E / End
      const n = this.buffer.length - this.cursor;
      if (n > 0) io.write(`\x1b[${n}C`);
      this.cursor = this.buffer.length;
      return;
    }

    if (data === '\x1b[D') {
      // Left arrow
      if (this.cursor > 0) {
        this.cursor--;
        io.write('\x1b[D');
      }
      return;
    }

    if (data === '\x1b[C') {
      // Right arrow
      if (this.cursor < this.buffer.length) {
        this.cursor++;
        io.write('\x1b[C');
      }
      return;
    }

    if (data === '\x1b[3~') {
      // Delete (forward)
      if (this.cursor < this.buffer.length) {
        const tail = this.buffer.slice(this.cursor + 1);
        this.buffer = this.buffer.slice(0, this.cursor) + tail;
        io.write(`${tail} \x1b[${tail.length + 1}D`);
      }
      return;
    }

    if (data === '\t') {
      // completion applies at end-of-line only
      if (this.completing || !this.buffer || this.cursor !== this.buffer.length) return;
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
          this.cursor = this.buffer.length;
          io.write(insert);
        } else {
          const lcp = commonPrefix(candidates);
          if (lcp.length > token.length) {
            const insert = lcp.slice(token.length);
            this.buffer += insert;
            this.cursor = this.buffer.length;
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
        this.historyIndex--;
        this.setLine(this.history[this.historyIndex]);
      }
      return;
    }

    if (data === '\x1b[B') {
      // Down arrow
      if (this.historyIndex < this.history.length) {
        this.historyIndex++;
        this.setLine(this.historyIndex === this.history.length ? '' : this.history[this.historyIndex]);
      }
      return;
    }

    if (code === 13) {
      // Enter
      io.write('\r\n');
      const cmd = this.buffer;
      this.buffer = '';
      this.cursor = 0;

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
      // Backspace (works mid-line: repaint the tail, then step back over it)
      if (this.cursor > 0) {
        const tail = this.buffer.slice(this.cursor);
        this.buffer = this.buffer.slice(0, this.cursor - 1) + tail;
        this.cursor--;
        io.write(`\b${tail} \x1b[${tail.length + 1}D`);
      }
    } else if (code < 32) {
      // Ignore other control characters
    } else {
      // Printable input: insert at the cursor, repaint any tail
      const tail = this.buffer.slice(this.cursor);
      this.buffer = this.buffer.slice(0, this.cursor) + data + tail;
      this.cursor += data.length;
      io.write(`${data}${tail}${tail ? `\x1b[${tail.length}D` : ''}`);
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
