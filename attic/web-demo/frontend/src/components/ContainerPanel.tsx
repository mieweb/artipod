import { useState, useEffect, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, Pod, CommandResult } from '../api';

interface Props {
  pod: Pod;
}

interface CommandHistory {
  command: string;
  result: CommandResult;
  timestamp: number;
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function ContainerPanel({ pod }: Props) {
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<CommandHistory[]>([]);
  const [commandBuffer, setCommandBuffer] = useState<string[]>([]);
  const [bufferIndex, setBufferIndex] = useState(-1);
  const queryClient = useQueryClient();
  const terminalRef = useRef<HTMLDivElement>(null);

  // Debug: Log the container data
  console.log('ContainerPanel - pod.container:', pod.container);

  const execMutation = useMutation({
    mutationFn: (cmd: string) => api.executeCommand(pod.id, cmd),
    onSuccess: (result, cmd) => {
      setHistory([
        ...history,
        {
          command: cmd,
          result,
          timestamp: Date.now(),
        },
      ]);
      // Add to command buffer (keep last 20)
      setCommandBuffer(prev => {
        const newBuffer = [...prev, cmd];
        return newBuffer.slice(-20);
      });
      setCommand('');
      setBufferIndex(-1);
      // Invalidate pod query to refresh activity stats
      queryClient.invalidateQueries({ queryKey: ['pod', pod.id] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => api.stopContainer(pod.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pod', pod.id] });
    },
  });

  // Auto-scroll to bottom when history changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [history, execMutation.isPending]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (command.trim()) {
      execMutation.mutate(command);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandBuffer.length === 0) return;
      
      const newIndex = bufferIndex === -1 
        ? commandBuffer.length - 1 
        : Math.max(0, bufferIndex - 1);
      
      setBufferIndex(newIndex);
      setCommand(commandBuffer[newIndex]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (bufferIndex === -1) return;
      
      const newIndex = bufferIndex + 1;
      
      if (newIndex >= commandBuffer.length) {
        setBufferIndex(-1);
        setCommand('');
      } else {
        setBufferIndex(newIndex);
        setCommand(commandBuffer[newIndex]);
      }
    }
  };

  return (
    <>
      <div className="header">
        <h2>Container Terminal: {pod.name}</h2>
        {pod.container && (
          <span className={`status-badge ${pod.container.status}`} aria-label={`Container status: ${pod.container.status}`}>
            {pod.container.status}
          </span>
        )}
      </div>
      <div className="content">
        <div className="card terminal-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0 }}>Container Terminal</h3>
          {pod.container && pod.container.status === 'running' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '0.85rem' }}>
              <span className="status-badge running" aria-label="Container status: running">
                running
              </span>
              {pod.container.command_count !== undefined && pod.container.command_count > 0 && (
                <span style={{ color: '#888' }}>
                  {pod.container.command_count} cmd{pod.container.command_count !== 1 ? 's' : ''}
                  {pod.container.last_command_at && (
                    <> · {formatTimeAgo(pod.container.last_command_at)}</>
                  )}
                </span>
              )}
              {pod.container.container_id && (
                <span style={{ color: '#888' }}>
                  {pod.container.command_count !== undefined && pod.container.command_count > 0 && <> · </>}
                  {pod.container.container_id.substring(0, 12)}
                </span>
              )}
              <button
                className="btn btn-danger btn-stop-container"
                onClick={() => stopMutation.mutate()}
                aria-label="Stop the running container"
              >
                Stop Container
              </button>
            </div>
          )}
        </div>

          <div className="terminal" role="log" aria-label="Terminal output" aria-live="polite" ref={terminalRef}>
            {history.length === 0 && (
              <div className="terminal-output" style={{ opacity: 0.5 }}>
                Container ready. Type a command below to execute.
              </div>
            )}

            {history.map((entry, index) => (
              <div key={index} className="terminal-entry">
                <div className="terminal-output terminal-command">$ {entry.command}</div>
                {entry.result.stdout && (
                  <div className="terminal-output terminal-stdout">{entry.result.stdout}</div>
                )}
                {entry.result.stderr && (
                  <div className="terminal-output error terminal-stderr">{entry.result.stderr}</div>
                )}
                <div className="terminal-output terminal-exit-code" style={{ color: '#9cdcfe', fontSize: 11 }}>
                  Exit code: {entry.result.exitCode}
                </div>
              </div>
            ))}

            {execMutation.isPending && (
              <div className="terminal-output" style={{ opacity: 0.5 }} aria-busy="true">
                Executing...
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} className="terminal-input">
            <input
              id="terminal-command-input"
              className="terminal-command-input"
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Enter bash command..."
              disabled={!pod.container || pod.container.status !== 'running'}
              aria-label="Terminal command input"
            />
            <button
              type="submit"
              className="btn btn-execute-command"
              disabled={
                !command.trim() ||
                execMutation.isPending ||
                !pod.container ||
                pod.container.status !== 'running'
              }
              aria-label="Execute command in container"
            >
              Execute
            </button>
          </form>
        </div>

        <div className="card quick-commands-card">
          <h3>Quick Commands</h3>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }} role="group" aria-label="Quick command buttons">
            <button
              className="btn btn-secondary quick-cmd-ls"
              onClick={() => setCommand('ls -la')}
              aria-label="Insert 'ls -la' command"
            >
              ls -la
            </button>
            <button
              className="btn btn-secondary quick-cmd-pwd"
              onClick={() => setCommand('pwd')}
              aria-label="Insert 'pwd' command"
            >
              pwd
            </button>
            <button
              className="btn btn-secondary quick-cmd-whoami"
              onClick={() => setCommand('whoami')}
              aria-label="Insert 'whoami' command"
            >
              whoami
            </button>
            <button
              className="btn btn-secondary quick-cmd-os-info"
              onClick={() => setCommand('cat /etc/os-release')}
              aria-label="Insert OS info command"
            >
              OS Info
            </button>
            <button
              className="btn btn-secondary quick-cmd-find"
              onClick={() => setCommand('find . -type f')}
              aria-label="Insert 'find files' command"
            >
              Find Files
            </button>
          </div>
        </div>

        <div className="card container-info-card">
          <h3>Container Info</h3>
          {pod.container && (
            <div style={{ fontFamily: 'monospace', fontSize: 13 }} role="region" aria-label="Container information">
              <div style={{ marginBottom: 8 }}>
                <strong>Container ID:</strong> {pod.container.container_id.slice(0, 12)}
              </div>
              <div style={{ marginBottom: 8 }}>
                <strong>Status:</strong> {pod.container.status}
              </div>
              <div>
                <strong>Started:</strong>{' '}
                {new Date(pod.container.created_at).toLocaleString()}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
