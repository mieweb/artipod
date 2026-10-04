import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api } from '../api';

interface Props {
  onPodCreated: (data: { name: string; useMainMount: boolean; mounts: { name: string; path: string; readonly: boolean }[] }) => void;
}

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

function buildTree(fileTree: { 
  folders: { path: string; children?: any }[]; 
  files: { path: string }[] 
}): TreeNode[] {
  // Process all folders and files at this level
  const nodes: TreeNode[] = [];
  
  // Add folders
  fileTree.folders.forEach(folder => {
    nodes.push({
      name: folder.path.split('/').pop() || folder.path,
      path: folder.path,
      isDirectory: true,
      children: folder.children ? buildTree(folder.children) : undefined
    });
  });
  
  // Add files
  fileTree.files.forEach(file => {
    nodes.push({
      name: file.path.split('/').pop() || file.path,
      path: file.path,
      isDirectory: false,
      children: undefined
    });
  });
  
  // Sort: directories first, then alphabetically
  return nodes.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
}

function TreeNodeComponent({ 
  node, 
  level, 
  selectedPath, 
  expandedPaths,
  onSelect,
  onToggle 
}: { 
  node: TreeNode; 
  level: number;
  selectedPath: string | null;
  expandedPaths: Set<string>;
  onSelect: (path: string, isDirectory: boolean) => void;
  onToggle: (path: string) => void;
}) {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = selectedPath === node.path;
  const hasChildren = node.children && node.children.length > 0;

  return (
    <div className="tree-node">
      <div
        className={`tree-node-content ${isSelected ? 'selected' : ''}`}
        style={{ paddingLeft: `${level * 20 + 8}px` }}
        onClick={() => onSelect(node.path, node.isDirectory)}
        onKeyDown={(e) => e.key === 'Enter' && onSelect(node.path, node.isDirectory)}
        tabIndex={0}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={node.isDirectory ? isExpanded : undefined}
        aria-label={`${node.isDirectory ? 'Folder' : 'File'}: ${node.name}`}
      >
        {node.isDirectory && hasChildren && (
          <span 
            className="tree-expand-icon"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.path);
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
          {node.isDirectory ? '📁' : '📄'}
        </span>
        <span className="tree-node-name">{node.name}</span>
      </div>
      {node.isDirectory && isExpanded && node.children && (
        <div className="tree-node-children">
          {node.children.map(child => (
            <TreeNodeComponent
              key={child.path}
              node={child}
              level={level + 1}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FilesystemPanel({ onPodCreated }: Props) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedIsDirectory, setSelectedIsDirectory] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showCreateFile, setShowCreateFile] = useState(false);
  const [showCreatePod, setShowCreatePod] = useState(false);
  const [showMountModal, setShowMountModal] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [podName, setPodName] = useState('');
  const [useMainMount, setUseMainMount] = useState(true);
  const [mounts, setMounts] = useState<{ name: string; path: string; readonly: boolean }[]>([]);
  const [modalMountName, setModalMountName] = useState('');
  const [modalMountPath, setModalMountPath] = useState('');
  const [modalMountReadonly, setModalMountReadonly] = useState(false);

  const queryClient = useQueryClient();

  const { data: fileTree } = useQuery({
    queryKey: ['fileTree'],
    queryFn: () => api.getFileTree(),
    refetchInterval: 2000,
  });

  const { data: fileData, isLoading: isLoadingFile } = useQuery({
    queryKey: ['workspaceFile', selectedPath],
    queryFn: () => api.getWorkspaceFile(selectedPath!),
    enabled: !!selectedPath && !selectedIsDirectory,
  });

  const tree = useMemo(() => {
    if (!fileTree) return [];
    return buildTree(fileTree);
  }, [fileTree]);

  const createFolderMutation = useMutation({
    mutationFn: (path: string) => api.createFolder(path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fileTree'] });
      setNewItemName('');
      setShowCreateFolder(false);
    },
  });

  const createFileMutation = useMutation({
    mutationFn: (data: { path: string; content: string }) =>
      api.createFile(data.path, data.content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fileTree'] });
      setNewItemName('');
      setFileContent('');
      setShowCreateFile(false);
    },
  });

  const handleSelect = (path: string, isDirectory: boolean) => {
    setSelectedPath(path);
    setSelectedIsDirectory(isDirectory);
  };

  const handleToggle = (path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleCreateFolder = () => {
    if (newItemName) {
      const path = selectedPath && selectedIsDirectory 
        ? `${selectedPath}/${newItemName}` 
        : newItemName;
      createFolderMutation.mutate(path);
    }
  };

  const handleCreateFile = () => {
    if (newItemName) {
      const path = selectedPath && selectedIsDirectory 
        ? `${selectedPath}/${newItemName}` 
        : newItemName;
      createFileMutation.mutate({ path, content: fileContent });
    }
  };

  const handleCreatePod = () => {
    if (podName) {
      onPodCreated({ name: podName, useMainMount: useMainMount, mounts });
      setPodName('');
      setUseMainMount(true);
      setMounts([]);
    }
  };

  return (
    <>
      <div className="header">
        <h2>Filesystem Browser</h2>
      </div>
      <div className="content filesystem-content">
        <div className="filesystem-layout">
          {/* Floating action buttons */}
          <div className="filesystem-actions">
            {!showCreatePod && (
              <>
                <button
                  className="action-btn"
                  onClick={() => {
                    setShowCreateFolder(true);
                    setShowCreateFile(false);
                    setNewItemName('');
                  }}
                  aria-label="Create new folder"
                  title="Create Folder"
                >
                  📁+
                </button>
                {selectedPath && selectedIsDirectory && (
                  <button
                    className="action-btn"
                    onClick={() => {
                      setShowCreateFile(true);
                      setShowCreateFolder(false);
                      setNewItemName('');
                      setFileContent('');
                    }}
                    aria-label="Create new file"
                    title="Create File"
                  >
                    📄+
                  </button>
                )}
                <button
                  className="action-btn"
                  onClick={() => {
                    setShowCreatePod(true);
                    setShowCreateFolder(false);
                    setShowCreateFile(false);
                    // If a directory is selected, open the mount modal
                    if (selectedPath && selectedIsDirectory) {
                      const dirName = selectedPath.split('/').filter(Boolean).pop() || selectedPath;
                      setModalMountPath(selectedPath);
                      setModalMountName(dirName);
                      setShowMountModal(true);
                    }
                  }}
                  aria-label="Create new ArtiPod"
                  title="Create ArtiPod"
                >
                  📦+
                </button>
              </>
            )}
            {showCreatePod && (
              <button
                className="action-btn"
                onClick={() => {
                  if (selectedPath && selectedIsDirectory) {
                    const dirName = selectedPath.split('/').filter(Boolean).pop() || selectedPath;
                    setModalMountPath(selectedPath);
                    setModalMountName(dirName);
                    setShowMountModal(true);
                  }
                }}
                disabled={!selectedPath || !selectedIsDirectory}
                aria-label="Add selected folder as mount"
                title="Add Mount"
              >
                📌
              </button>
            )}
          </div>

          {/* Directory tree */}
          <div className="filesystem-tree">
            <div className="tree-header">
              <h3>Workspace Directory</h3>
              <div className="selected-path">
                <strong>Selected:</strong> {selectedPath || '/'}
              </div>
            </div>
            <div 
              className="tree-container" 
              role="tree" 
              aria-label="Workspace file tree"
              onClick={(e) => {
                // If clicking on the container itself (not a child element)
                if (e.target === e.currentTarget) {
                  setSelectedPath('');
                  setSelectedIsDirectory(true);
                }
              }}
            >
              {tree.length === 0 && (
                <div className="empty-state">No files or folders yet</div>
              )}
              {tree.map(node => (
                <TreeNodeComponent
                  key={node.path}
                  node={node}
                  level={0}
                  selectedPath={selectedPath}
                  expandedPaths={expandedPaths}
                  onSelect={handleSelect}
                  onToggle={handleToggle}
                />
              ))}
            </div>
          </div>

          {/* File viewer */}
          {selectedPath && !selectedIsDirectory && (
            <div className="file-viewer-panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <h3>File: {selectedPath.split('/').pop()}</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    className="btn btn-secondary"
                    onClick={() => {
                      setSelectedPath(null);
                      setSelectedIsDirectory(false);
                    }}
                    style={{ fontSize: 12, padding: '4px 12px' }}
                    aria-label="Close file viewer"
                  >
                    Close File
                  </button>
                </div>
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
                <strong>Location:</strong> {selectedPath && selectedIsDirectory ? `${selectedPath}/` : '(root)/'}
                <strong style={{ marginLeft: 8 }}>Full path:</strong> {selectedPath && selectedIsDirectory ? `${selectedPath}/${newItemName || '...'}` : newItemName || '...'}
              </div>
              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  onClick={handleCreateFolder}
                  disabled={!newItemName}
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
                <strong>Location:</strong> {selectedPath && selectedIsDirectory ? `${selectedPath}/` : '(root)/'}
                <strong style={{ marginLeft: 8 }}>Full path:</strong> {selectedPath && selectedIsDirectory ? `${selectedPath}/${newItemName || '...'}` : newItemName || '...'}
              </div>
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
                  disabled={!newItemName}
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

          {/* Pod creation section */}
          {showCreatePod && (
          <div className="create-form-panel">
            <h3>Create ArtiPod</h3>
            <div className="form-group">
            <label htmlFor="pod-name-input">Pod Name</label>
            <input
              id="pod-name-input"
              className="pod-name-input"
              type="text"
              placeholder="e.g., My Project"
              value={podName}
              onChange={(e) => setPodName(e.target.value)}
              aria-label="Name for the new pod"
            />
          </div>

          <div className="form-group" style={{ marginTop: 16 }}>
            <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={useMainMount}
                onChange={(e) => setUseMainMount(e.target.checked)}
                aria-label="Include automatic main mount"
                style={{ width: 16, height: 16 }}
              />
              <span>
                Include automatic main mount
                <span style={{ fontSize: 12, color: '#666', fontWeight: 'normal', marginLeft: 6 }}>
                  (writable workspace for pod)
                </span>
              </span>
            </label>
          </div>

          <h4 style={{ marginTop: 20, marginBottom: 10 }}>Mounts</h4>
          {mounts.length === 0 ? (
            <p style={{ color: '#666', fontStyle: 'italic', fontSize: 14 }}>No mounts added yet. Select a folder and click the 📌 button to add a mount.</p>
          ) : (
            <div role="list" aria-label="Configured mounts for this pod">
              {mounts.map((mount, idx) => (
                <div
                  key={idx}
                  role="listitem"
                  className="mount-list-item"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '8px 12px',
                    background: '#f8f9fa',
                    borderRadius: 4,
                    marginBottom: 8,
                  }}
                >
                  <div>
                    <strong>{mount.name}</strong>: {mount.path}
                    {mount.readonly && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: '#666', background: '#e9ecef', padding: '2px 6px', borderRadius: 3 }}>read-only</span>
                    )}
                  </div>
                  <button
                    className="btn btn-danger btn-remove-mount"
                    style={{ padding: '4px 8px', fontSize: 12 }}
                    onClick={() => setMounts(mounts.filter((_, i) => i !== idx))}
                    aria-label={`Remove mount ${mount.name}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          <button
            className="btn btn-success btn-create-pod"
            style={{ marginTop: 20 }}
            onClick={handleCreatePod}
            disabled={!podName}
            aria-label="Create pod with configured mounts"
          >
            Create Pod
          </button>
          <button
            className="btn btn-secondary"
            style={{ marginTop: 10 }}
            onClick={() => {
              setShowCreatePod(false);
              setPodName('');
              setUseMainMount(true);
              setMounts([]);
              setShowMountModal(false);
              setModalMountName('');
              setModalMountPath('');
              setModalMountReadonly(false);
            }}
            aria-label="Cancel pod creation"
          >
            Cancel
          </button>
        </div>
        )}
        </div>

        {/* Mount modal */}
        {showMountModal && (
          <div className="modal-overlay" onClick={() => setShowMountModal(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <h3>Add Mount</h3>
              <div className="form-group">
                <label htmlFor="modal-mount-name-input">Mount Name</label>
                <input
                  id="modal-mount-name-input"
                  type="text"
                  placeholder="e.g., src"
                  value={modalMountName}
                  onChange={(e) => setModalMountName(e.target.value)}
                  aria-label="Name for the mount"
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label htmlFor="modal-mount-path-input">Folder Path</label>
                <input
                  id="modal-mount-path-input"
                  type="text"
                  value={modalMountPath}
                  readOnly
                  aria-label="Folder path for the mount"
                  style={{ background: '#f8f9fa', cursor: 'not-allowed' }}
                />
              </div>
              <div style={{ marginTop: 16 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 'normal' }}>
                  <input
                    type="checkbox"
                    checked={modalMountReadonly}
                    onChange={(e) => setModalMountReadonly(e.target.checked)}
                    aria-label="Mount as read-only"
                    style={{ width: 16, height: 16 }}
                  />
                  Read-only mount
                </label>
                <p style={{ fontSize: 12, color: '#666', marginTop: 4, marginLeft: 24 }}>
                  Read-only mounts cannot be written to from the container or API.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                <button
                  className="btn btn-success"
                  onClick={() => {
                    if (modalMountName && modalMountPath) {
                      setMounts([...mounts, { name: modalMountName, path: modalMountPath, readonly: modalMountReadonly }]);
                      setShowMountModal(false);
                      setModalMountName('');
                      setModalMountPath('');
                      setModalMountReadonly(false);
                    }
                  }}
                  disabled={!modalMountName}
                  aria-label="Confirm and add mount"
                >
                  Add Mount
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setShowMountModal(false);
                    setModalMountName('');
                    setModalMountPath('');
                    setModalMountReadonly(false);
                  }}
                  aria-label="Cancel mount addition"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
