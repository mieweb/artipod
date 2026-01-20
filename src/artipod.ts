import { ArtiMount } from './artimount';
import {
  ContainerHandle,
  CommandResult,
  ContainerOptions,
  buildContainerImage,
  createContainer,
  executeCommandInContainer,
  stopAndRemoveContainer,
} from './containerUtils';
import { ArtiPodOptions } from './types';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

interface BuildPromptOptions {
  maxSize?: number;
  includeFiles?: boolean;
  maxFilesPerMount?: number;
}

/**
 * ArtiPod - top-level container aggregating multiple ArtiMounts
 */
export class ArtiPod {
  private static readonly DIRECTORY_FILE_LIMIT = 20;
  private static readonly TRUNCATED_DIRECTORY_SAMPLE_SIZE = 3;
  
  private mounts: Map<string, ArtiMount> = new Map();
  private container?: ContainerHandle;
  private imageName?: string;
  private commandTimeout: number = 30000;
  private id: string;
  private workspaceDir?: string;
  private useMainMount: boolean;
  private initialized: boolean = false;

  /**
   * Format file size in human-readable format
   * @param bytes - Size in bytes
   * @returns Formatted size string (e.g., "2.3 KB", "1.5 MB")
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  constructor(options?: ArtiPodOptions) {
    // Generate or use provided ID
    this.id = options?.id || crypto.randomBytes(16).toString('hex');
    this.workspaceDir = options?.workspaceDir;
    this.useMainMount = options?.useMainMount ?? true;

    // Validate that workspaceDir is provided if main mount should be created
    if (this.useMainMount && !this.workspaceDir) {
      throw new Error('workspaceDir is required unless useMainMount is false');
    }

    // Process initial mounts if provided
    if (options?.mounts) {
      const names = new Set<string>();
      for (const mount of options.mounts) {
        const name = mount.getName();
        if (names.has(name)) {
          throw new Error(`Duplicate mount name: ${name}`);
        }
        // Prevent collision: if useMainMount is true, a 'main' mount will be auto-created
        if (name === 'main' && this.useMainMount) {
          throw new Error(
            "Cannot provide a mount named 'main' when useMainMount is true. " +
            "Either set useMainMount to false and provide the main mount explicitly, " +
            "or omit the main mount and let it be auto-created."
          );
        }
        names.add(name);
        this.mounts.set(name, mount);
      }
    }
  }

  /**
   * Get the pod's unique identifier
   * @returns The pod ID
   */
  getId(): string {
    return this.id;
  }

  /**
   * Initialize the pod by creating the main mount and initializing all mounts
   * This method is idempotent and can be called multiple times safely
   */
  async initialize(): Promise<void> {
    // Return early if already initialized (idempotent)
    if (this.initialized) {
      return;
    }

    // Create and initialize main mount if needed
    if (this.useMainMount && this.workspaceDir) {
      const mainMountPath = path.join(this.workspaceDir, `artipod-${this.id}`);
      
      // Create directory (recursive: true means no error if exists)
      await fs.mkdir(mainMountPath, { recursive: true });
      
      // Create main mount
      const mainMount = new ArtiMount('main', mainMountPath, false);
      await mainMount.initialize();
      this.mounts.set('main', mainMount);
    }

    // Initialize all user-provided mounts
    for (const mount of this.mounts.values()) {
      // Skip main mount as it's already initialized
      if (mount.getName() !== 'main') {
        await mount.initialize();
      }
    }

    this.initialized = true;
  }

  /**
   * Clean up the main mount directory
   * Removes the main mount and deletes its directory from the filesystem
   */
  async cleanupMainMount(): Promise<void> {
    const mainMount = this.mounts.get('main');
    if (!mainMount || !this.useMainMount) {
      return; // Silent success if no main mount
    }

    // Remove from mounts map
    this.mounts.delete('main');

    // Delete the directory
    if (this.workspaceDir) {
      const mainMountPath = path.join(this.workspaceDir, `artipod-${this.id}`);
      await fs.rm(mainMountPath, { recursive: true, force: true });
    }
  }

  /**
   * Add a mount to the pod
   * @param mount - ArtiMount to add
   * @throws Error if mount name already exists or is invalid
   */
  addMount(mount: ArtiMount): void {
    const name = mount.getName();
    
    // Validate mount name
    if (!name || name.trim() === '') {
      throw new Error('Mount name cannot be empty');
    }
    if (name.includes('<') || name.includes('>')) {
      throw new Error(`Mount name '${name}' contains invalid characters (< or >)`);
    }
    // Validate 'main' mount name
    if (name === 'main' && this.useMainMount) {
      throw new Error("Mount name 'main' is reserved for the auto-generated main mount");
    }
    
    if (this.mounts.has(name)) {
      throw new Error(`Mount with name '${name}' already exists`);
    }
    this.mounts.set(name, mount);
  }

  /**
   * Remove a mount from the pod
   * @param name - Name of mount to remove
   */
  removeMount(name: string): boolean {
    return this.mounts.delete(name);
  }

  /**
   * Get a mount by name
   * @param name - Name of mount
   */
  getMount(name: string): ArtiMount | undefined {
    return this.mounts.get(name);
  }

  /**
   * Get all mount instances
   */
  getMounts(): ArtiMount[] {
    return Array.from(this.mounts.values());
  }

  /**
   * Get all mount names
   */
  getMountNames(): string[] {
    return Array.from(this.mounts.keys());
  }

  /**
   * Format a flat list of file paths into an indented tree structure
   * Root files are shown first, then directories with their contents
   * Directories with many files are truncated
   * 
   * @param files - Array of file info objects from mount.list()
   * @param maxFiles - Maximum total files to include
   * @returns Formatted tree string, or empty string if no files
   */
  private formatFileTree(files: { path: string; size: number }[], maxFiles: number): string {
    if (files.length === 0) {
      return '';
    }

    // Build directory structure with file sizes
    interface TreeNode {
      files: Array<{ name: string; size: number }>;
      dirs: Map<string, TreeNode>;
    }

    const root: TreeNode = { files: [], dirs: new Map() };

    for (const file of files) {
      const parts = file.path.split('/');
      let current = root;

      // Navigate/create directory structure
      for (let i = 0; i < parts.length - 1; i++) {
        const dirName = parts[i];
        if (!current.dirs.has(dirName)) {
          current.dirs.set(dirName, { files: [], dirs: new Map() });
        }
        current = current.dirs.get(dirName)!;
      }

      // Add file to current directory with size
      current.files.push({ 
        name: parts[parts.length - 1],
        size: file.size
      });
    }

    // Format tree into string
    const lines: string[] = [];
    let totalFilesShown = 0;

    // Helper to count total files in a directory tree
    const countFiles = (n: TreeNode): number => {
      let count = n.files.length;
      for (const child of n.dirs.values()) {
        count += countFiles(child);
      }
      return count;
    };

    const formatNode = (node: TreeNode, indent: string, isRoot: boolean): boolean => {
      if (totalFilesShown >= maxFiles) {
        return false; // Stop processing
      }

      // Sort files and directories alphabetically
      const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
      const sortedDirs = [...node.dirs.keys()].sort();

      // At root level, show all root files first
      if (isRoot) {
        for (const file of sortedFiles) {
          if (totalFilesShown >= maxFiles) {
            return false;
          }
          lines.push(`${indent}${file.name} (${this.formatSize(file.size)})`);
          totalFilesShown++;
        }
        
        // Then show all directories (just the names with /)
        for (const dirName of sortedDirs) {
          if (totalFilesShown >= maxFiles) {
            return false;
          }
          
          const dirNode = node.dirs.get(dirName)!;
          lines.push(`${indent}${dirName}/`);
          
          const fileCount = countFiles(dirNode);
          
          // If directory has too many files, show sample and truncate
          if (fileCount > ArtiPod.DIRECTORY_FILE_LIMIT) {
            const sampleFiles = dirNode.files
              .sort((a, b) => a.name.localeCompare(b.name))
              .slice(0, ArtiPod.TRUNCATED_DIRECTORY_SAMPLE_SIZE);
            
            for (const file of sampleFiles) {
              if (totalFilesShown >= maxFiles) {
                return false;
              }
              lines.push(`${indent}  ${file.name} (${this.formatSize(file.size)})`);
              totalFilesShown++;
            }
            
            const remaining = fileCount - ArtiPod.TRUNCATED_DIRECTORY_SAMPLE_SIZE;
            lines.push(`${indent}  ... [${remaining} more files] ...`);
          } else {
            // Show all files and subdirectories in this directory
            if (!formatNode(dirNode, indent + '  ', false)) {
              return false;
            }
          }
        }
      } else {
        // At non-root levels, interleave files and directories alphabetically
        // Create a combined sorted list
        const items: Array<{type: 'file' | 'dir', name: string, size?: number}> = [
          ...sortedFiles.map(f => ({type: 'file' as const, name: f.name, size: f.size})),
          ...sortedDirs.map(name => ({type: 'dir' as const, name}))
        ].sort((a, b) => a.name.localeCompare(b.name));
        
        for (const item of items) {
          if (totalFilesShown >= maxFiles) {
            return false;
          }
          
          if (item.type === 'file') {
            lines.push(`${indent}${item.name} (${this.formatSize(item.size!)})`);
            totalFilesShown++;
          } else {
            const dirNode = node.dirs.get(item.name)!;
            lines.push(`${indent}${item.name}/`);
            
            const fileCount = countFiles(dirNode);
            
            // If directory has too many files, show sample and truncate
            if (fileCount > ArtiPod.DIRECTORY_FILE_LIMIT) {
              const sampleFiles = dirNode.files
                .sort((a, b) => a.name.localeCompare(b.name))
                .slice(0, ArtiPod.TRUNCATED_DIRECTORY_SAMPLE_SIZE);
              
              for (const file of sampleFiles) {
                if (totalFilesShown >= maxFiles) {
                  return false;
                }
                lines.push(`${indent}  ${file.name} (${this.formatSize(file.size)})`);
                totalFilesShown++;
              }
              
              const remaining = fileCount - ArtiPod.TRUNCATED_DIRECTORY_SAMPLE_SIZE;
              lines.push(`${indent}  ... [${remaining} more files] ...`);
            } else {
              // Show all files and subdirectories in this directory
              if (!formatNode(dirNode, indent + '  ', false)) {
                return false;
              }
            }
          }
        }
      }

      return true;
    };

    formatNode(root, '', true);

    // Add truncation marker if we hit the limit
    if (totalFilesShown >= maxFiles && files.length > maxFiles) {
      lines.push(`... [truncated: ${files.length - totalFilesShown} more files] ...`);
    }

    return lines.join('\n');
  }

  /**
   * Build a prompt by aggregating README content from all mounts in the pod
   * 
   * @param options - Configuration options
   * @param options.maxSize - Maximum prompt size in characters. Truncates if exceeded.
   * @param options.includeFiles - Whether to include file listings. Defaults to true.
   * @param options.maxFilesPerMount - Maximum files to show per mount. Defaults to 100.
   * @returns XML-formatted prompt string with README contents
   */
  async buildPrompt(options?: BuildPromptOptions): Promise<string> {
    const sections: string[] = [];

    const includeFiles = options?.includeFiles !== false;
    const maxFilesPerMount = options?.maxFilesPerMount ?? 100;

    // Collect README content and file listings from each mount
    for (const mount of this.mounts.values()) {
      const mountName = mount.getName();
      const readmeContents = await mount.getReadmeContents();
      
      // Build dataSource section with name and readme elements
      const readmeTags = readmeContents.map(content => 
        `<readme>\n${content}\n</readme>`
      ).join('\n');
      
      let dataSourceContent = `<dataSource>\n<name>${mountName}</name>\n${readmeTags}`;
      
      // Add file listing if enabled
      if (includeFiles) {
        const files = await mount.list();
        const fileTree = this.formatFileTree(files, maxFilesPerMount);
        
        if (fileTree) {
          dataSourceContent += `\n<files>\n${fileTree}\n</files>`;
        }
      }
      
      dataSourceContent += '\n</dataSource>';
      sections.push(dataSourceContent);
    }

    if (sections.length === 0) {
      return '';
    }

    let prompt = `<context>\n${sections.join('\n\n')}\n</context>`;

    // Apply maxSize truncation if needed
    if (options?.maxSize && prompt.length > options.maxSize) {
      prompt = prompt.substring(0, options.maxSize) + '\n... [TRUNCATED]';
    }

    return prompt;
  }

  /**
   * Start a container for this pod with all mounts
   * @param dockerfilePath - Path to Dockerfile for building the container image
   * @param options - Optional container configuration
   * @returns Container handle
   */
  async startContainer(dockerfilePath: string, options?: ContainerOptions): Promise<ContainerHandle> {
    if (this.container) {
      throw new Error('Container already running for this pod');
    }

    // Build mount binds from all mounts
    const mounts: string[] = [];
    for (const [mountName, mount] of this.mounts) {
      const hostPath = mount.getRootPath();
      const containerPath = `/context/${mountName}`;
      const mountSuffix = mount.isReadOnly() ? ':ro' : '';
      mounts.push(`${hostPath}:${containerPath}${mountSuffix}`);
    }

    // Build or reuse image
    this.imageName = await buildContainerImage(dockerfilePath);
    
    // Store timeout for later use
    this.commandTimeout = options?.commandTimeout || 30000;

    // Create and start container
    this.container = await createContainer(this.imageName, mounts, options);
    return this.container;
  }

  /**
   * Stop and remove the container for this pod
   */
  async stopContainer(): Promise<void> {
    if (!this.container) {
      throw new Error('No running container for this pod');
    }

    await stopAndRemoveContainer(this.container);
    this.container = undefined;
    this.imageName = undefined;
  }

  /**
   * Execute a bash command in the pod's container
   * @param command - Bash command to execute
   * @param timeout - Optional timeout in milliseconds (overrides default commandTimeout)
   * @returns Command execution result
   */
  async executeCommand(command: string, timeout?: number): Promise<CommandResult> {
    if (!this.container) {
      throw new Error('No running container for this pod');
    }

    const effectiveTimeout = timeout ?? this.commandTimeout;
    return await executeCommandInContainer(this.container, command, effectiveTimeout);
  }

  /**
   * Check if this pod has a running container
   */
  hasContainer(): boolean {
    return !!this.container;
  }

  /**
   * Get the container ID if one is running
   */
  getContainerId(): string | undefined {
    return this.container?.id;
  }
}
