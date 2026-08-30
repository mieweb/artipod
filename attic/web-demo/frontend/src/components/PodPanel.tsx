import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api, Pod, CommandResult } from '../api';

interface Props {
  pod: Pod;
  onDelete: () => void;
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

interface CommandHistory {
  command: string;
  result: CommandResult;
  timestamp: number;
}

interface TreeNode {
  name: string;
  path: string;
  mount: string; // Which mount this belongs to
  isDirectory: boolean;
  size?: number; // File size in bytes
  readonly?: boolean; // Whether this mount is read-only
  children?: TreeNode[];
}

function buildMountTree(filesByMount: Record<string, Array<{ path: string; size: number; isDirectory?: boolean }>>, mounts?: Array<{ mount_name: string; readonly: boolean }>): TreeNode[] {
  const mountNodes: TreeNode[] = [];
  
  // Build a lookup for mount readonly status
  const readonlyLookup = new Map<string, boolean>();
  if (mounts) {
    for (const mount of mounts) {
      readonlyLookup.set(mount.mount_name, mount.readonly);
    }
  }

  for (const [mountName, entries] of Object.entries(filesByMount)) {
    const isReadonly = readonlyLookup.get(mountName) ?? false;
    // Create a tree structure for this mount
    const root: Map<string, any> = new Map();
    
    entries.forEach(entry => {
      const parts = entry.path.split('/').filter(Boolean);
      if (parts.length === 0) return; // Skip empty paths
      
      let current = root;
      
      parts.forEach((part, index) => {
        const isLast = index === parts.length - 1;
        
        if (!current.has(part)) {
          current.set(part, {
            isDirectory: isLast ? (entry.isDirectory ?? false) : true,
            children: new Map(),
            size: isLast && !entry.isDirectory ? entry.size : undefined
          });
        }
        
        if (!isLast) {
          current = current.get(part).children;
        }
      });
    });

    // Convert the map structure to TreeNode structure
    const convertToTreeNodes = (map: Map<string, any>, parentPath: string): TreeNode[] => {
      const nodes: TreeNode[] = [];
      
      map.forEach((value, name) => {
        const currentPath = parentPath ? `${parentPath}/${name}` : name;
        const node: TreeNode = {
          name,
          path: currentPath,
          mount: mountName,
          isDirectory: value.isDirectory,
          size: value.size,
          readonly: isReadonly,
          children: value.isDirectory && value.children.size > 0 
            ? convertToTreeNodes(value.children, currentPath)
            : undefined
        };
        nodes.push(node);
      });
      
      // Sort: directories first, then alphabetically
      return nodes.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
    };

    // Add the mount as a root node
    mountNodes.push({
      name: mountName,
      path: '',
      mount: mountName,
      isDirectory: true,
      readonly: isReadonly,
      children: convertToTreeNodes(root, '')
    });
  }

  return mountNodes;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TreeNodeComponent({ 
  node, 
  level, 
  selectedPath, 
  selectedMount,
  expandedKeys,
  onSelect,
  onToggle 
}: { 
  node: TreeNode; 
  level: number;
  selectedPath: string | null;
  selectedMount: string | null;
  expandedKeys: Set<string>;
  onSelect: (mount: string, path: string, isDirectory: boolean) => void;
  onToggle: (key: string) => void;
}) {
  const nodeKey = `${node.mount}:${node.path}`;
  const isExpanded = expandedKeys.has(nodeKey);
  const isSelected = selectedMount === node.mount && selectedPath === node.path;
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div className="tree-node">
      <div
        className={`tree-node-content ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${level * 20 + 8}px` }}
        onClick={() => onSelect(node.mount, node.path, node.isDirectory)}
        onKeyDown={(e) => e.key === 'Enter' && onSelect(node.mount, node.path, node.isDirectory)}
        tabIndex={0}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={node.isDirectory ? isExpanded : undefined}
        aria-label={`${node.isDirectory ? 'Folder' : 'File'}: ${node.name}${level === 0 ? ' (mount)' : ''}`}
      >
        {node.isDirectory && hasChildren && (
          <span 
            className="tree-expand-icon"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(nodeKey);
            }}
            role="button"
            aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
          >
            {isExpanded ? '▼' : '▶'}
          </span>
        )}
        {node.isDirectory && !hasChildren && (
          <span className="tree-expand-icon-placeholder">○</span>
        )}
        <span className="tree-node-icon">
          {level === 0 ? (node.readonly ? '👁' : '📌') : node.isDirectory ? '📁' : '📄'}
        </span>
        <span className="tree-node-name">
          {node.name}
          {!node.isDirectory && node.size !== undefined && (
            <span style={{ marginLeft: 8, opacity: 0.6, fontSize: '0.9em' }}>
              ({formatSize(node.size)})
            </span>
          )}
        </span>
      </div>
      {node.isDirectory && isExpanded && node.children && (
        <div className="tree-node-children">
          {node.children.map(child => (
            <TreeNodeComponent
              key={`${child.mount}:${child.path}`}
              node={child}
              level={level + 1}
              selectedPath={selectedPath}
              selectedMount={selectedMount}
              expandedKeys={expandedKeys}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function PodPanel({ pod, onDelete }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedMount, setSelectedMount] = useState<string | null>(null);
  const [selectedIsDirectory, setSelectedIsDirectory] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showCreateFile, setShowCreateFile] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [fileContent, setFileContent] = useState('');
  
  // Line range state
  const [startLine, setStartLine] = useState<string>('');
  const [endLine, setEndLine] = useState<string>('');
  const [useLineRange, setUseLineRange] = useState(false);
  
  // Terminal state
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<CommandHistory[]>([]);
  const [commandBuffer, setCommandBuffer] = useState<string[]>([]);
  const [bufferIndex, setBufferIndex] = useState(-1);
  const terminalRef = useRef<HTMLDivElement>(null);

  const queryClient = useQueryClient();

  // Reset history and file viewer when switching pods
  useEffect(() => {
    setHistory([]);
    setCommand('');
    setCommandBuffer([]);
    setBufferIndex(-1);
    setSelectedPath(null);
    setSelectedMount(null);
    setSelectedIsDirectory(false);
  }, [pod.id]);

  const { data: files = {} } = useQuery({
    queryKey: ['files', pod.id],
    queryFn: () => api.getFiles(pod.id),
    refetchInterval: 2000,
  });

  const { data: fileData, isLoading: isLoadingFile } = useQuery({
    queryKey: ['podFile', pod.id, selectedMount, selectedPath, startLine, endLine, useLineRange],
    queryFn: () => {
      const start = useLineRange && startLine ? parseInt(startLine, 10) : undefined;
      const end = useLineRange && endLine ? parseInt(endLine, 10) : undefined;
      return api.getFile(pod.id, selectedMount!, selectedPath!, start, end);
    },
    enabled: !!selectedMount && !!selectedPath && !selectedIsDirectory,
  });

  const { data: promptData } = useQuery({
    queryKey: ['podPrompt', pod.id],
    queryFn: () => api.getPodPrompt(pod.id),
    refetchInterval: 2000,
  });

  const tree = useMemo(() => {
    return buildMountTree(files, pod.mounts);
  }, [files, pod.mounts]);

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
    },
    onError: (error, cmd) => {
      toast.error(`Command failed: ${(error as Error).message}`);
      setHistory([
        ...history,
        {
          command: cmd,
          result: {
            stdout: '',
            stderr: (error as Error).message,
            exitCode: -1,
          },
          timestamp: Date.now(),
        },
      ]);
      // Add to command buffer even on error (keep last 20)
      setCommandBuffer(prev => {
        const newBuffer = [...prev, cmd];
        return newBuffer.slice(-20);
      });
      setCommand('');
      setBufferIndex(-1);
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => api.stopContainer(pod.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pod', pod.id] });
    },
  });

  const createFolderMutation = useMutation({
    mutationFn: (data: { mount: string; path: string }) =>
      api.createFolderInMount(pod.id, data.mount, data.path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files', pod.id] });
      setNewItemName('');
      setShowCreateFolder(false);
      toast.success('Folder created');
    },
    onError: (error: Error) => {
      toast.error(`Failed to create folder: ${error.message}`);
    },
  });

  const createFileMutation = useMutation({
    mutationFn: (data: { mount: string; path: string; content: string }) =>
      api.createFileInMount(pod.id, data.mount, data.path, data.content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files', pod.id] });
      setNewItemName('');
      setFileContent('');
      setShowCreateFile(false);
      toast.success('File created');
    },
    onError: (error: Error) => {
      toast.error(`Failed to create file: ${error.message}`);
    },
  });

  const startContainerMutation = useMutation({
    mutationFn: () => api.startContainer(pod.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pod', pod.id] });
    },
  });

  const deletePodMutation = useMutation({
    mutationFn: () => api.deletePod(pod.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      toast.success('Pod deleted successfully');
      onDelete();
    },
    onError: (error) => {
      toast.error(`Failed to delete pod: ${(error as Error).message}`);
    },
  });

  // Auto-scroll terminal to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [history, execMutation.isPending]);

  const handleSelect = (mount: string, path: string, isDirectory: boolean) => {
    setSelectedMount(mount);
    setSelectedPath(path);
    setSelectedIsDirectory(isDirectory);
  };

  // Check if selected mount is readonly
  const isSelectedMountReadonly = useMemo(() => {
    if (!selectedMount || !pod.mounts) return false;
    const mount = pod.mounts.find(m => m.mount_name === selectedMount);
    return mount?.readonly ?? false;
  }, [selectedMount, pod.mounts]);

  const handleToggle = (key: string) => {
    setExpandedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleCreateFolder = () => {
    if (newItemName && selectedMount) {
      const path = selectedPath && selectedIsDirectory
        ? `${selectedPath}/${newItemName}`
        : newItemName;
      createFolderMutation.mutate({ mount: selectedMount, path });
    }
  };

  const handleCreateFile = () => {
    if (newItemName && selectedMount) {
      const path = selectedPath && selectedIsDirectory
        ? `${selectedPath}/${newItemName}`
        : newItemName;
      createFileMutation.mutate({ mount: selectedMount, path, content: fileContent });
    }
  };

  const handleSubmitCommand = (e: React.FormEvent) => {
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
        <h2>Pod: {pod.name}</h2>
        {pod.container && (
          <span className={`status-badge ${pod.container.status}`}>
            {pod.container.status}
          </span>
        )}
        <button
          className="btn btn-danger"
          onClick={() => {
            if (confirm(`Are you sure you want to delete pod "${pod.name}"? The container will be stopped but mount folders will be preserved.`)) {
              deletePodMutation.mutate();
            }
          }}
          disabled={deletePodMutation.isPending}
          aria-label="Delete pod"
          style={{ fontSize: '12px', padding: '4px 10px', marginLeft: 'auto' }}
        >
          {deletePodMutation.isPending ? 'Deleting...' : '✕ Delete'}
        </button>
      </div>
      <div className="content filesystem-content">
        <div className="filesystem-layout">
          {/* Floating action buttons */}
          <div className="filesystem-actions">
            {selectedMount && selectedIsDirectory && (
              <button
                className="action-btn"
                onClick={() => {
                  setShowCreateFolder(true);
                  setShowCreateFile(false);
                  setNewItemName('');
                }}
                aria-label="Create new folder in selected mount"
                title="Create Folder"
              >
                📁+
              </button>
            )}
            {selectedMount && selectedIsDirectory && (
              <button
                className="action-btn"
                onClick={() => {
                  setShowCreateFile(true);
                  setShowCreateFolder(false);
                  setNewItemName('');
                  setFileContent('');
                }}
                aria-label="Create new file in selected mount"
                title="Create File"
              >
                📄+
              </button>
            )}
          </div>

          {/* Directory tree */}
          <div className="filesystem-tree">
            <div className="tree-header">
              <h3>Pod Mounts</h3>
              <div className="selected-path">
                <strong>Selected:</strong> {selectedMount ? `${selectedMount}${selectedPath ? `/${selectedPath}` : ''}` : '(none)'}
              </div>
            </div>
            <div 
              className="tree-container" 
              role="tree" 
              aria-label="Pod mounts file tree"
            >
              {tree.length === 0 && (
                <div className="empty-state">No mounts or files yet</div>
              )}
              {tree.map(node => (
                <TreeNodeComponent
                  key={`${node.mount}:${node.path}`}
                  node={node}
                  level={0}
                  selectedPath={selectedPath}
                  selectedMount={selectedMount}
                  expandedKeys={expandedKeys}
                  onSelect={handleSelect}
                  onToggle={handleToggle}
                />
              ))}
            </div>
          </div>

          {/* File viewer */}
          {selectedMount && selectedPath && !selectedIsDirectory && (
            <div className="file-viewer-panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h3 style={{ marginBottom: 4 }}>File: {selectedPath.split('/').pop()}</h3>
                  <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 8 }}>
                    Mount: {selectedMount}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      setSelectedPath(null);
                      setSelectedMount(null);
                      setSelectedIsDirectory(false);
                      setUseLineRange(false);
                      setStartLine('');
                      setEndLine('');
                    }}
                    style={{ fontSize: 12, padding: '4px 12px' }}
                    aria-label="Close file viewer"
                  >
                    Close File
                  </button>
                </div>
              </div>
              
              {/* Line range controls */}
              <div style={{ marginBottom: 12, padding: '8px 12px', background: '#f8f9fa', borderRadius: 4, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={useLineRange}
                    onChange={(e) => setUseLineRange(e.target.checked)}
                  />
                  Read line range
                </label>
                {useLineRange && (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <label htmlFor="start-line" style={{ fontSize: 12 }}>Start:</label>
                      <input
                        id="start-line"
                        type="number"
                        min="1"
                        value={startLine}
                        onChange={(e) => setStartLine(e.target.value)}
                        placeholder="1"
                        style={{ width: 70, padding: '2px 6px', fontSize: 12 }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <label htmlFor="end-line" style={{ fontSize: 12 }}>End:</label>
                      <input
                        id="end-line"
                        type="number"
                        min="1"
                        value={endLine}
                        onChange={(e) => setEndLine(e.target.value)}
                        placeholder="∞"
                        style={{ width: 70, padding: '2px 6px', fontSize: 12 }}
                      />
                    </div>
                    <span style={{ fontSize: 11, opacity: 0.6, fontStyle: 'italic' }}>
                      (1-indexed, inclusive)
                    </span>
                  </>
                )}
              </div>
              
              {isLoadingFile ? (
                <div style={{ padding: 16, opacity: 0.5 }}>Loading...</div>
              ) : fileData ? (
                <pre className="file-content">{fileData.content}</pre>
              ) : (
                <div style={{ padding: 16, opacity: 0.5 }}>Unable to load file</div>
              )}
            </div>
          )}

          {/* Create forms */}
          {showCreateFolder && (
            <div className="create-form-panel">
              <h3>Create Folder</h3>
              <div className="form-group">
                <label htmlFor="new-folder-name">Folder Name</label>
                <input
                  id="new-folder-name"
                  type="text"
                  placeholder="e.g., src"
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                  aria-label="New folder name"
                  autoFocus
                />
              </div>
              <div className="form-location">
                <strong>Mount:</strong> {selectedMount || '(none)'}{isSelectedMountReadonly && ' (read-only)'}
                <br />
                <strong>Location:</strong> {selectedPath && selectedIsDirectory ? `${selectedPath}/` : '(root)/'}
                <br />
                <strong>Full path:</strong> {selectedPath && selectedIsDirectory ? `${selectedPath}/${newItemName || '...'}` : newItemName || '...'}
              </div>
              {isSelectedMountReadonly && (
                <div style={{ padding: '8px 12px', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 4, marginTop: 12, fontSize: 13 }}>
                  ⚠️ This mount is <strong>read-only</strong>. Creating folders is not permitted and will fail. This form is available for testing the expected error behavior.
                </div>
              )}
              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleCreateFolder}
                  disabled={!newItemName || !selectedMount}
                >
                  Create Folder
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setShowCreateFolder(false);
                    setNewItemName('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {showCreateFile && (
            <div className="create-form-panel">
              <h3>Create File</h3>
              <div className="form-group">
                <label htmlFor="new-file-name">File Name</label>
                <input
                  id="new-file-name"
                  type="text"
                  placeholder="e.g., index.ts"
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                  aria-label="New file name"
                  autoFocus
                />
              </div>
              <div className="form-location">
                <strong>Mount:</strong> {selectedMount || '(none)'}{isSelectedMountReadonly && ' (read-only)'}
                <br />
                <strong>Location:</strong> {selectedPath && selectedIsDirectory ? `${selectedPath}/` : '(root)/'}
                <br />
                <strong>Full path:</strong> {selectedPath && selectedIsDirectory ? `${selectedPath}/${newItemName || '...'}` : newItemName || '...'}
              </div>
              {isSelectedMountReadonly && (
                <div style={{ padding: '8px 12px', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: 4, marginTop: 12, fontSize: 13 }}>
                  ⚠️ This mount is <strong>read-only</strong>. Creating files is not permitted and will fail. This form is available for testing the expected error behavior.
                </div>
              )}
              <div className="form-group">
                <label htmlFor="new-file-content">Content</label>
                <textarea
                  id="new-file-content"
                  placeholder="File content..."
                  value={fileContent}
                  onChange={(e) => setFileContent(e.target.value)}
                  aria-label="File content"
                  rows={6}
                />
              </div>
              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleCreateFile}
                  disabled={!newItemName || !selectedMount}
                >
                  Create File
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setShowCreateFile(false);
                    setNewItemName('');
                    setFileContent('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Container section */}
          {!showCreateFolder && !showCreateFile && (
            <div className="create-form-panel">
              <h3>Container Terminal</h3>
              {pod.container && pod.container.status === 'running' ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '0.85rem' }}>
                      <span className={`status-badge ${pod.container.status}`}>
                        {pod.container.status}
                      </span>
                      {pod.container.command_count !== undefined && pod.container.command_count > 0 && (
                        <span style={{ color: '#888' }}>
                          {pod.container.command_count} cmd{pod.container.command_count !== 1 ? 's' : ''}
                          {pod.container.last_command_at && (
                            <> · {new Date(pod.container.last_command_at).toLocaleTimeString()}</>
                          )}
                        </span>
                      )}
                      {pod.container.container_id && (
                        <span style={{ color: '#888' }}>
                          {pod.container.command_count !== undefined && pod.container.command_count > 0 && <> · </>}
                          ID: {pod.container.container_id.substring(0, 12)}
                        </span>
                      )}
                    </div>
                    <button
                      className="btn btn-danger btn-stop-container"
                      onClick={() => stopMutation.mutate()}
                      disabled={pod.container.status !== 'running'}
                      style={{ fontSize: 12, padding: '4px 8px' }}
                    >
                      Stop Container
                    </button>
                  </div>

                  <div className="terminal" role="log" aria-label="Terminal output" ref={terminalRef}>
                    {history.length === 0 && (
                      <div className="terminal-output" style={{ opacity: 0.5 }}>
                        Container ready. Type a command below to execute.
                      </div>
                    )}

                    {history.map((entry, idx) => (
                      <div key={idx} className="terminal-entry">
                        <div className="terminal-output terminal-command" style={{ color: '#569cd6', marginTop: 16 }}>
                          $ {entry.command}
                        </div>
                        {entry.result.stdout && (
                          <div className="terminal-output success terminal-stdout">{entry.result.stdout}</div>
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
                      <div className="terminal-output" style={{ opacity: 0.5 }}>
                        Executing...
                      </div>
                    )}
                  </div>

                  <form onSubmit={handleSubmitCommand} className="terminal-input">
                    <input
                      className="terminal-command-input"
                      type="text"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Enter bash command..."
                      disabled={pod.container.status !== 'running'}
                    />
                    <button
                      type="submit"
                      className="btn btn-execute-command"
                      disabled={
                        !command.trim() ||
                        execMutation.isPending ||
                        pod.container.status !== 'running'
                      }
                    >
                      Execute
                    </button>
                  </form>

                  <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setCommand('ls -la')}
                      style={{ fontSize: 11, padding: '4px 8px' }}
                    >
                      ls -la
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setCommand('pwd')}
                      style={{ fontSize: 11, padding: '4px 8px' }}
                    >
                      pwd
                    </button>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setCommand('whoami')}
                      style={{ fontSize: 11, padding: '4px 8px' }}
                    >
                      whoami
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <p style={{ marginBottom: 16 }}>No container running. Start one to execute commands.</p>
                  <button
                    className="btn btn-primary"
                    onClick={() => startContainerMutation.mutate()}
                    disabled={startContainerMutation.isPending}
                  >
                    {startContainerMutation.isPending ? 'Starting...' : 'Start Container'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Prompt Preview section */}
          {!showCreateFolder && !showCreateFile && (
            <div className="create-form-panel">
              <h3>Prompt Preview</h3>
              <pre style={{
                fontFamily: 'monospace',
                fontSize: '12px',
                backgroundColor: '#f5f5f5',
                padding: '12px',
                borderRadius: '4px',
                maxHeight: '400px',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                border: '1px solid #ddd'
              }}>
                {promptData?.prompt || 'Loading prompt...'}
              </pre>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
