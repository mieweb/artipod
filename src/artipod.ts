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

  constructor(mounts?: ArtiMount[]) {
    if (mounts) {
      const names = new Set<string>();
      for (const mount of mounts) {
        const name = mount.getName();
        if (names.has(name)) {
          throw new Error(`Duplicate mount name: ${name}`);
        }
        names.add(name);
        this.mounts.set(name, mount);
      }
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
      mounts.push(`${hostPath}:${containerPath}`);
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
   * @returns Command execution result
   */
  async executeCommand(command: string): Promise<CommandResult> {
    if (!this.container) {
      throw new Error('No running container for this pod');
    }

    return await executeCommandInContainer(this.container, command, this.commandTimeout);
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
