import * as path from 'path';
import type { PodFs } from './podfs.js';
import { nodePodFs } from './nodePodFs.js';

/**
 * ArtiMount - a named storage component containing files
 */
export class ArtiMount {
  private name: string;
  private rootPath: string;
  private readonly: boolean;
  private fs: PodFs;

  /**
   * Create a new ArtiMount
   * @param name - Mount name
   * @param rootPath - Filesystem location for the mount
   * @param readonly - If true, write operations are disabled (default: false)
   * @param podFs - Filesystem implementation (default: node:fs/promises adapter)
   */
  constructor(name: string, rootPath: string, readonly: boolean = false, podFs?: PodFs) {
    this.name = name;
    this.rootPath = path.resolve(rootPath);
    this.readonly = readonly;
    this.fs = podFs ?? nodePodFs();
  }

  /**
   * Initialize the mount (verify directory exists)
   */
  async initialize(): Promise<void> {
    // Verify rootPath exists
    try {
      const stats = await this.fs.stat(this.rootPath);
      if (!stats.isDirectory()) {
        throw new Error(`Mount path ${this.rootPath} exists but is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Mount path ${this.rootPath} does not exist`);
      }
      throw error;
    }
  }

  /**
   * Get the mount name
   */
  getName(): string {
    return this.name;
  }

  /**
   * Get the root path
   */
  getRootPath(): string {
    return this.rootPath;
  }

  /**
   * Check if the mount is read-only
   */
  isReadOnly(): boolean {
    return this.readonly;
  }

  /**
   * Get the filesystem implementation backing this mount
   */
  getFs(): PodFs {
    return this.fs;
  }

  /**
   * Resolve a relative path to an absolute path within the mount
   * @param relativePath - Path relative to mount root
   */
  private _resolve(relativePath: string): string {
    const resolved = path.resolve(this.rootPath, relativePath);

    // Prevent path traversal outside mount (exact-boundary check: '/a' must
    // not admit '/ab/...', only '/a' itself or '/a/...')
    if (resolved !== this.rootPath && !resolved.startsWith(this.rootPath + path.sep)) {
      throw new Error(`Path ${relativePath} is outside mount root`);
    }

    return resolved;
  }

  /**
   * Get README content from the mount root
   * Returns array of readme contents (one per found README file)
   */
  async getReadmeContents(): Promise<string[]> {
    const readmeVariants = ['README.md', 'readme.md'];
    const contents: string[] = [];
    const foundFiles = new Set<string>();
    
    // Get all files in root to check exact names (case-sensitive)
    try {
      const allFiles = await this.fs.readdir(this.rootPath);
      for (const variant of readmeVariants) {
        if (allFiles.includes(variant) && !foundFiles.has(variant.toLowerCase())) {
          try {
            const content = await this.read(variant);
            contents.push(content);
            foundFiles.add(variant.toLowerCase());
          } catch {
            // File read error, skip
          }
        }
      }
    } catch {
      // Directory read error, return empty
    }
    
    return contents;
  }

  /**
   * Read a file from the mount
   * @param relativePath - Path relative to mount root
   * @param startLine - Optional starting line number (1-indexed, inclusive)
   * @param endLine - Optional ending line number (1-indexed, inclusive)
   * @returns File content as string. If line numbers provided, returns only those lines.
   */
  async read(relativePath: string, startLine?: number, endLine?: number): Promise<string> {
    const fullPath = this._resolve(relativePath);
    
    try {
      const content = await this.fs.readFile(fullPath, 'utf-8');
      
      // If no line range specified, return full content
      if (startLine === undefined && endLine === undefined) {
        return content;
      }
      
      // Split on any newline sequence (platform-agnostic)
      const lines = content.split(/\r?\n/);
      
      // Validate and normalize line numbers (1-indexed to 0-indexed)
      const start = startLine !== undefined ? Math.max(0, startLine - 1) : 0;
      const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
      
      if (start >= lines.length) {
        throw new Error(`Start line ${startLine} exceeds file length (${lines.length} lines)`);
      }
      
      // Extract the requested lines and rejoin with newlines
      return lines.slice(start, end).join('\n');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`File not found: ${relativePath}`);
      }
      throw error;
    }
  }

  /**
   * Write a file to the mount
   * @param relativePath - Path relative to mount root
   * @param content - File content (string or Buffer)
   * @throws Error if mount is read-only
   */
  async write(
    relativePath: string,
    content: string | Uint8Array
  ): Promise<void> {
    if (this.readonly) {
      throw new Error(`Cannot write to read-only mount '${this.name}'`);
    }
    const fullPath = this._resolve(relativePath);
    const dir = path.dirname(fullPath);
    
    // Ensure parent directories exist
    await this.fs.mkdir(dir, { recursive: true });
    
    await this.fs.writeFile(fullPath, content);
  }

  /**
   * Create a folder in the mount
   * @param relativePath - Path relative to mount root
   * @throws Error if mount is read-only
   */
  async createFolder(relativePath: string): Promise<void> {
    if (this.readonly) {
      throw new Error(`Cannot create folder in read-only mount '${this.name}'`);
    }
    const fullPath = this._resolve(relativePath);
    await this.fs.mkdir(fullPath, { recursive: true });
  }

  /**
   * List all files in the mount
   * @param relativePath - Optional subdirectory to list (relative to root)
   * @returns Array of file info objects with path and size
   */
  async list(relativePath?: string): Promise<{ path: string; size: number }[]> {
    const startPath = relativePath ? this._resolve(relativePath) : this.rootPath;
    const files: { fullPath: string; size: number }[] = [];
    
    await this._listRecursive(startPath, files);
    
    // Return paths relative to root with sizes
    return files.map(f => ({
      path: path.relative(this.rootPath, f.fullPath),
      size: f.size
    }));
  }

  /**
   * List all files and directories in the mount
   * @param relativePath - Optional subdirectory to list (relative to root)
   * @returns Array of entries with path, size, and isDirectory flag
   */
  async listWithDirectories(relativePath?: string): Promise<{ path: string; size: number; isDirectory: boolean }[]> {
    const startPath = relativePath ? this._resolve(relativePath) : this.rootPath;
    const entries: { fullPath: string; size: number; isDirectory: boolean }[] = [];
    
    await this._listWithDirectoriesRecursive(startPath, entries);
    
    // Return paths relative to root with sizes and directory flag
    return entries.map(e => ({
      path: path.relative(this.rootPath, e.fullPath),
      size: e.size,
      isDirectory: e.isDirectory
    }));
  }

  /**
   * Recursively list files and directories
   * @param dir - Directory to list
   * @param entries - Array to accumulate entries
   */
  private async _listWithDirectoriesRecursive(
    dir: string, 
    entries: { fullPath: string; size: number; isDirectory: boolean }[]
  ): Promise<void> {
    try {
      const dirEntries = await this.fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of dirEntries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          entries.push({ fullPath, size: 0, isDirectory: true });
          await this._listWithDirectoriesRecursive(fullPath, entries);
        } else if (entry.isFile()) {
          try {
            const stats = await this.fs.stat(fullPath);
            entries.push({ fullPath, size: stats.size, isDirectory: false });
          } catch {
            // If we can't stat the file, skip it
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }

  /**
   * Recursively list files in a directory
   * @param dir - Directory to list
   * @param files - Array to accumulate file paths and sizes
   */
  private async _listRecursive(dir: string, files: { fullPath: string; size: number }[]): Promise<void> {
    try {
      const entries = await this.fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await this._listRecursive(fullPath, files);
        } else if (entry.isFile()) {
          try {
            const stats = await this.fs.stat(fullPath);
            files.push({ fullPath, size: stats.size });
          } catch {
            // If we can't stat the file, skip it
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}
