/**
 * @artipod/core/console — the Ctrl+~ drop-in overlay console (docs/console.md).
 *
 * One call gives any web app a Quake-style drop-down artipod shell. Builtin
 * zero-dependency renderer (no xterm): a log <pre> + an <input> line driven
 * by the same sandbox/agent surfaces every other consumer uses. SSR-safe:
 * without a DOM this is a no-op. Consumes only /host-style contracts +
 * pod.events.
 */
import type { Sandbox } from '../sandbox/types.js';
import type { PodEvents } from '../events.js';

export interface InstallConsoleOptions {
  sandbox: Sandbox;
  events?: PodEvents;
  /** Hotkey: 'Ctrl+`' (default) — also matches Ctrl+~ (shifted backquote). */
  hotkey?: string;
  /** Secondary tabs: run nothing, say why. */
  readOnly?: boolean;
  /** Overlay height as a CSS size. Default: '45vh'. */
  height?: string;
}

export interface ConsoleHandle {
  toggle(): void;
  show(): void;
  hide(): void;
  dispose(): void;
  readonly isOpen: boolean;
}

const NOOP_HANDLE: ConsoleHandle = {
  toggle() {},
  show() {},
  hide() {},
  dispose() {},
  isOpen: false,
};

/** Strip ANSI SGR sequences — the builtin renderer is plain text. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

export function installConsole(options: InstallConsoleOptions): ConsoleHandle {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return NOOP_HANDLE; // SSR / Node: no-op by contract
  }

  const { sandbox, events, readOnly, height = '45vh' } = options;

  const overlay = document.createElement('div');
  overlay.setAttribute('data-artipod-console', '');
  overlay.style.cssText = [
    'position:fixed;top:0;left:0;right:0;z-index:2147483000',
    `height:${height};display:none;flex-direction:column`,
    'background:rgba(20,20,20,.96);color:#e6e6e6',
    'font:13px/1.4 Menlo,Monaco,"Courier New",monospace',
    'border-bottom:1px solid #444;box-shadow:0 6px 24px rgba(0,0,0,.5)',
  ].join(';');

  const log = document.createElement('pre');
  log.style.cssText = 'flex:1;margin:0;padding:8px 10px;overflow:auto;white-space:pre-wrap;word-break:break-word';

  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'display:flex;border-top:1px solid #333';
  const promptEl = document.createElement('span');
  promptEl.style.cssText = 'padding:6px 0 6px 10px;color:#8bd5a0;white-space:nowrap';
  const input = document.createElement('input');
  input.type = 'text';
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.style.cssText =
    'flex:1;background:transparent;border:0;outline:0;color:inherit;font:inherit;padding:6px 10px';
  inputRow.append(promptEl, input);
  overlay.append(log, inputRow);
  document.body.appendChild(overlay);

  let open = false;
  let busy = false;
  let abortController: AbortController | null = null;
  const history: string[] = [];
  let historyIndex = 0;
  const disposers: Array<() => void> = [];

  const append = (text: string) => {
    log.append(stripAnsi(text));
    log.scrollTop = log.scrollHeight;
  };
  const refreshPrompt = () => {
    promptEl.textContent = `${sandbox.getCwd()} $`;
  };

  append('artipod console — type a command, `notes` for help, Ctrl+` to hide\n');
  refreshPrompt();

  if (events) {
    disposers.push(
      events.on('agent:tool-call', (e) => {
        if (e.phase === 'call') append(`⚙ ${e.name} ${e.arguments}\n`);
      }),
      events.on('approval:request', (e) => {
        append(`⛔ approval requested: ${e.verb}${e.target ? ` ${e.target}` : ''} — denied (Phase 6.5 lands the flow)\n`);
      }),
    );
  }

  const run = async (cmd: string) => {
    append(`${sandbox.getCwd()} $ ${cmd}\n`);
    if (!cmd.trim()) return;
    if (readOnly) {
      append('read-only session: commands are disabled in this tab\n');
      return;
    }
    history.push(cmd);
    historyIndex = history.length;
    busy = true;
    abortController = new AbortController();
    try {
      const r = await sandbox.exec(cmd, { signal: abortController.signal });
      if (r.stdout) append(r.stdout);
      if (r.stderr) append(r.stderr);
    } catch (e) {
      append(`${String(e)}\n`);
    } finally {
      busy = false;
      abortController = null;
      refreshPrompt();
    }
  };

  const onInputKey = async (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !busy) {
      const cmd = input.value;
      input.value = '';
      await run(cmd);
    } else if (e.key === 'c' && e.ctrlKey && busy) {
      abortController?.abort();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex > 0) {
        historyIndex--;
        input.value = history[historyIndex];
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex < history.length) {
        historyIndex++;
        input.value = historyIndex === history.length ? '' : history[historyIndex];
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      if (!input.value) return;
      const { candidates, replaceStart } = await sandbox.complete(input.value);
      if (candidates.length === 1) {
        const token = input.value.slice(replaceStart);
        input.value += candidates[0].slice(token.length) + (candidates[0].endsWith('/') ? '' : ' ');
      } else if (candidates.length > 1) {
        append(`${candidates.slice(0, 40).join('  ')}${candidates.length > 40 ? '  …' : ''}\n`);
      }
    }
  };
  input.addEventListener('keydown', onInputKey);

  const show = () => {
    open = true;
    overlay.style.display = 'flex';
    refreshPrompt();
    input.focus();
  };
  const hide = () => {
    open = false;
    overlay.style.display = 'none';
  };
  const toggle = () => (open ? hide() : show());

  // Ctrl+` and Ctrl+~ (same physical key, shifted) toggle the overlay.
  const onHotkey = (e: KeyboardEvent) => {
    if (e.ctrlKey && (e.key === '`' || e.key === '~')) {
      e.preventDefault();
      toggle();
    }
  };
  window.addEventListener('keydown', onHotkey);
  disposers.push(() => window.removeEventListener('keydown', onHotkey));
  disposers.push(() => input.removeEventListener('keydown', onInputKey));

  return {
    toggle,
    show,
    hide,
    dispose() {
      for (const d of disposers.splice(0)) d();
      overlay.remove();
    },
    get isOpen() {
      return open;
    },
  };
}
