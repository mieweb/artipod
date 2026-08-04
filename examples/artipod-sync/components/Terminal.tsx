'use client';

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface TerminalCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface TerminalProps {
  onCommand: (cmd: string) => Promise<TerminalCommandResult>;
  /** Returns the shell cwd for the prompt. */
  getPrompt?: () => string;
}

const RED = '\x1b[31m';
const RESET = '\x1b[0m';

/** xterm wants \r\n; sandbox output uses \n. */
const toCrLf = (s: string) => s.replace(/\r?\n/g, '\r\n');

export default function Terminal({ onCommand, getPrompt }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const commandRef = useRef('');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(0);

  // Keep latest callbacks without re-creating the terminal on re-render.
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const getPromptRef = useRef(getPrompt);
  getPromptRef.current = getPrompt;

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

    const prompt = () => {
      const cwd = getPromptRef.current?.() ?? '';
      term.write(`\r\n${cwd} $ `);
    };

    term.writeln('Welcome to artipod-sync — bash over ZenFS (just-bash)');
    term.writeln("Type 'help' for shell notes.");
    prompt();

    let busy = false;

    term.onData(async (data) => {
      if (busy) return; // ignore typing while a command runs
      const code = data.charCodeAt(0);

      // Handle Arrow Keys for History
      if (data === '\x1b[A') { // Up Arrow
        if (historyIndexRef.current > 0) {
          while (commandRef.current.length > 0) {
            term.write('\b \b');
            commandRef.current = commandRef.current.slice(0, -1);
          }
          historyIndexRef.current--;
          const prevCmd = historyRef.current[historyIndexRef.current];
          term.write(prevCmd);
          commandRef.current = prevCmd;
        }
        return;
      }

      if (data === '\x1b[B') { // Down Arrow
        if (historyIndexRef.current < historyRef.current.length) {
          while (commandRef.current.length > 0) {
            term.write('\b \b');
            commandRef.current = commandRef.current.slice(0, -1);
          }
          historyIndexRef.current++;
          if (historyIndexRef.current === historyRef.current.length) {
            commandRef.current = '';
          } else {
            const nextCmd = historyRef.current[historyIndexRef.current];
            term.write(nextCmd);
            commandRef.current = nextCmd;
          }
        }
        return;
      }

      if (code === 13) { // Enter
        term.write('\r\n');
        const cmd = commandRef.current;
        commandRef.current = '';

        if (cmd.trim()) {
          historyRef.current.push(cmd);
          historyIndexRef.current = historyRef.current.length;

          busy = true;
          try {
            const result = await onCommandRef.current(cmd);
            if (result.stdout) term.write(toCrLf(result.stdout));
            if (result.stderr) term.write(`${RED}${toCrLf(result.stderr)}${RESET}`);
          } catch (e) {
            term.write(`${RED}${toCrLf(String(e))}${RESET}\r\n`);
          } finally {
            busy = false;
          }
        }
        prompt();
      } else if (code === 127) { // Backspace
        if (commandRef.current.length > 0) {
          commandRef.current = commandRef.current.slice(0, -1);
          term.write('\b \b');
        }
      } else if (code < 32) {
        // Ignore other control characters
      } else {
        commandRef.current += data;
        term.write(data);
      }
    });

    const handleResize = () => fitAddon.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      xtermRef.current = null;
    };
  }, []);

  return <div id="terminal-container" ref={terminalRef} className="w-full h-full" />;
}
