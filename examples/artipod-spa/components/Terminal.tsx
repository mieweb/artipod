'use client';

/**
 * Thin xterm shell over @artipod/core/host's TerminalSession — this
 * component owns xterm, addons, theme and the banner; the line discipline
 * lives in the package. Becomes the reusable artipod-shell component (D3)
 * at U4: the contract is already attach-at-mount / dispose-at-unmount.
 */
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TerminalSession } from '@artipod/core/host';
import type { PodEvents } from '@artipod/core/host';
import type { Sandbox } from '@artipod/core/sandbox';
import corePkg from '@artipod/core/package.json';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  sandbox: Sandbox;
  events?: PodEvents;
  readOnly?: boolean;
}

const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const CORE_VERSION = process.env.NEXT_PUBLIC_ARTIPOD_VERSION ?? corePkg.version;

const BANNER = [
  '',
  `${CYAN}┌─┐┬─┐┌┬┐┬┌─┐┌─┐┌┬┐   ┌┐ ┌─┐┌─┐┬ ┬${RESET}`,
  `${CYAN}├─┤├┬┘ │ │├─┘│ │ ││───├┴┐├─┤└─┐├─┤${RESET}`,
  `${CYAN}┴ ┴┴└─ ┴ ┴┴  └─┘─┴┘   └─┘┴ ┴└─┘┴ ┴${RESET}`,
  '',
  `${DIM}@artipod/core ${CORE_VERSION} · bash over ZenFS · just-bash${RESET}`,
  'https://github.com/mieweb/artipod',
  `${DIM}Type 'help' or 'notes' to get started.${RESET}`,
  `${DIM}Tab completes · Ctrl+R searches · Ctrl+C cancels · Ctrl+\` toggles terminal${RESET}`,
];

export default function Terminal({ sandbox, events, readOnly }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      theme: { background: '#1e1e1e', foreground: '#ffffff' },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 14,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    setTimeout(() => {
      try {
        fitAddon.fit();
      } catch {
        // container can be 0-sized mid-transition
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

    // Observe the container, not the window: mobile keyboards resize the
    // --app-height container without firing window.resize.
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // mid-transition
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

  return <div ref={terminalRef} className="h-full w-full" />;
}
