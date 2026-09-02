'use client';

/**
 * Thin xterm shell over @artipod/core/host's TerminalSession (plan Phase 2):
 * this component owns xterm, addons, theme and the banner; the line
 * discipline (history, tab completion, Ctrl+C, prompt, agent echo via
 * agent:tool-call) lives in the package.
 */
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { TerminalSession } from '@artipod/core/host';
import type { PodEvents } from '@artipod/core/host';
// version of the bundled @artipod/core (resolved at build time)
import corePkg from '@artipod/core/package.json';
import type { Sandbox } from '@/lib/sandbox/types';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  sandbox: Sandbox;
  events?: PodEvents;
  readOnly?: boolean;
}

const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const REPO_URL = 'https://github.com/mieweb/artipod';

// export-static.mjs injects the full dev version ("0.7.1+10 (ee5c01b, 2026-09-02)");
// plain `next dev`/`next build` fall back to the package version.
const CORE_VERSION = process.env.NEXT_PUBLIC_ARTIPOD_VERSION ?? corePkg.version;

// 34 cols × 3 rows so it fits a phone-width terminal
const BANNER = [
  '',
  `${CYAN}┌─┐┬─┐┌┬┐┬┌─┐┌─┐┌┬┐   ┌┐ ┌─┐┌─┐┬ ┬${RESET}`,
  `${CYAN}├─┤├┬┘ │ │├─┘│ │ ││───├┴┐├─┤└─┐├─┤${RESET}`,
  `${CYAN}┴ ┴┴└─ ┴ ┴┴  └─┘─┴┘   └─┘┴ ┴└─┘┴ ┴${RESET}`,
  '',
  `${DIM}@artipod/core ${CORE_VERSION} · bash over ZenFS · just-bash${RESET}`,
  REPO_URL,
  `${DIM}Type 'help' or 'notes' to get started.${RESET}`,
  `${DIM}Tab completes · Ctrl+C cancels · Ctrl+\` toggles terminal${RESET}`,
];

export default function Terminal({ sandbox, events, readOnly }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#ffffff',
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // makes URLs (banner repo link, command output) clickable
    term.loadAddon(new WebLinksAddon((event, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));

    try {
      term.open(terminalRef.current);
    } catch (e) {
      console.error('Error opening terminal:', e);
    }

    setTimeout(() => {
      try {
        fitAddon.fit();
      } catch (e) {
        console.error('Failed to fit terminal:', e);
      }
    }, 100);

    xtermRef.current = term;

    const session = new TerminalSession({
      sandbox,
      events,
      readOnly,
      io: { write: (text) => term.write(text) },
      banner: BANNER,
      version: CORE_VERSION,
    });
    const data = term.onData((d) => void session.handleData(d));

    // Observe the container, not the window: the iOS keyboard resizes our
    // --app-height container without ever firing window.resize.
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // container can be 0-sized mid-transition
      }
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      resizeObserver.disconnect();
      data.dispose();
      session.dispose();
      term.dispose();
      xtermRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div id="terminal-container" ref={terminalRef} className="w-full h-full" />;
}
