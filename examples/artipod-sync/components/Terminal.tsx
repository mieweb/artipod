'use client';

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  onCommand: (cmd: string) => Promise<string>;
}

export default function Terminal({ onCommand }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const commandRef = useRef('');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(0);

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

    if (!terminalRef.current) {
      return;
    }
    
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
      term.write('\r\n$ ');
    };

    term.writeln('Welcome to Browser Git Shell PoC');
    prompt();

    term.onData(async (data) => {
      const code = data.charCodeAt(0);

      // Handle Arrow Keys for History
      if (data === '\x1b[A') { // Up Arrow
        if (historyIndexRef.current > 0) {
          // Clear current line
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
          // Clear current line
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
          // Add to history
          historyRef.current.push(cmd);
          historyIndexRef.current = historyRef.current.length;

          const output = await onCommand(cmd);
          if (output) {
            // Handle newlines properly for xterm
            term.write(output.replace(/\n/g, '\r\n'));
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
  }, [onCommand]);

  return <div id="terminal-container" ref={terminalRef} className="w-full h-full" />;
}
