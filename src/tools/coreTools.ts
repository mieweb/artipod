/**
 * Core file tool implementations matching vscode-copilot-chat interfaces
 */

import { ArtiMount } from '../artimount.js';
import {
  ToolName,
  ToolHandler,
  ToolResult,
  ReadFileResult,
  ListDirResult,
  ReadFileParams,
  ICreateFileParams,
  IListDirParams,
  ICreateDirectoryParams,
  isReadFileParamsV2,
} from './types.js';
import {
  readFileDefinition,
  createFileDefinition,
  listDirDefinition,
  createDirectoryDefinition,
  MAX_LINES_PER_READ,
} from './definitions.js';

/**
 * Clamp a number between min and max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Get line count from content
 */
function getLineCount(content: string): number {
  return content.split(/\r?\n/).length;
}

/**
 * ReadFile tool handler
 */
export class ReadFileTool implements ToolHandler<ReadFileParams, ReadFileResult> {
  readonly name = ToolName.ReadFile;
  readonly definition = readFileDefinition;

  constructor(private mount: ArtiMount) {}

  async execute(params: ReadFileParams): Promise<ReadFileResult> {
    try {
      // Resolve path relative to mount if not absolute
      const relativePath = this.resolveRelativePath(params.filePath);

      // First read full file to get total line count
      const fullContent = await this.mount.read(relativePath);
      const totalLines = getLineCount(fullContent);

      let start: number;
      let end: number;
      let truncated = false;

      if (isReadFileParamsV2(params)) {
        // V2 format: offset/limit
        if (params.offset !== undefined && params.offset > totalLines) {
          return {
            success: false,
            error: `Invalid offset ${params.offset}: file only has ${totalLines} line${totalLines === 1 ? '' : 's'}. Line numbers are 1-indexed.`,
            filePath: params.filePath,
            startLine: 0,
            endLine: 0,
            totalLines,
            truncated: false,
          };
        }
        const limit = clamp(params.limit || Infinity, 1, MAX_LINES_PER_READ - 1);
        start = clamp(params.offset ?? 1, 1, totalLines);
        end = clamp(start + limit - 1, 1, totalLines);
        // Signal truncation if we applied a limit other than what was requested
        truncated = limit !== params.limit && end < totalLines;
      } else {
        // V1 format: startLine/endLine
        start = clamp(params.startLine, 1, totalLines);
        end = clamp(params.endLine, 1, totalLines);
      }

      // Ensure start <= end
      if (start > end) {
        [end, start] = [start, end];
      }

      // Read the requested lines
      const content = await this.mount.read(relativePath, start, end);

      return {
        success: true,
        content,
        filePath: params.filePath,
        startLine: start,
        endLine: end,
        totalLines,
        truncated,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        filePath: params.filePath,
        startLine: 0,
        endLine: 0,
        totalLines: 0,
        truncated: false,
      };
    }
  }

  private resolveRelativePath(filePath: string): string {
    const rootPath = this.mount.getRootPath();
    if (filePath.startsWith(rootPath)) {
      return filePath.substring(rootPath.length).replace(/^\//, '');
    }
    return filePath.replace(/^\//, '');
  }
}

/**
 * CreateFile tool handler
 */
export class CreateFileTool implements ToolHandler<ICreateFileParams, ToolResult> {
  readonly name = ToolName.CreateFile;
  readonly definition = createFileDefinition;

  constructor(private mount: ArtiMount) {}

  async execute(params: ICreateFileParams): Promise<ToolResult> {
    try {
      const relativePath = this.resolveRelativePath(params.filePath);

      // Check if file already exists
      const files = await this.mount.list();
      const exists = files.some(f => f.path === relativePath);
      
      if (exists) {
        return {
          success: false,
          error: `File already exists. You must use an edit tool to modify it.`,
        };
      }

      // Write the file (directories are created automatically)
      await this.mount.write(relativePath, params.content ?? '');

      return {
        success: true,
        content: `Created file at ${params.filePath}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveRelativePath(filePath: string): string {
    const rootPath = this.mount.getRootPath();
    if (filePath.startsWith(rootPath)) {
      return filePath.substring(rootPath.length).replace(/^\//, '');
    }
    return filePath.replace(/^\//, '');
  }
}

/**
 * ListDir tool handler
 */
export class ListDirTool implements ToolHandler<IListDirParams, ListDirResult> {
  readonly name = ToolName.ListDirectory;
  readonly definition = listDirDefinition;

  constructor(private mount: ArtiMount) {}

  async execute(params: IListDirParams): Promise<ListDirResult> {
    try {
      const relativePath = this.resolveRelativePath(params.path);

      // Get all entries with directory info
      const entries = await this.mount.listWithDirectories(relativePath || undefined);

      // Filter to immediate children of the requested path
      const prefix = relativePath ? relativePath + '/' : '';
      const immediateChildren = new Map<string, boolean>();

      for (const entry of entries) {
        let relPath = entry.path;
        if (prefix && relPath.startsWith(prefix)) {
          relPath = relPath.substring(prefix.length);
        } else if (prefix && !relPath.startsWith(prefix)) {
          continue; // Not under requested path
        }

        // Get the first path component (immediate child)
        const firstSlash = relPath.indexOf('/');
        const childName = firstSlash >= 0 ? relPath.substring(0, firstSlash) : relPath;

        if (childName && !immediateChildren.has(childName)) {
          // If it's a directory or if there's more path after, it's a directory
          const isDir = entry.isDirectory || firstSlash >= 0;
          immediateChildren.set(childName, isDir);
        }
      }

      // Also check if we're at root and have entries directly
      if (!relativePath) {
        for (const entry of entries) {
          const firstSlash = entry.path.indexOf('/');
          const childName = firstSlash >= 0 ? entry.path.substring(0, firstSlash) : entry.path;
          if (childName && !immediateChildren.has(childName)) {
            const isDir = entry.isDirectory || firstSlash >= 0;
            immediateChildren.set(childName, isDir);
          }
        }
      }

      const result: ListDirResult['entries'] = [];
      for (const [name, isDirectory] of immediateChildren) {
        result.push({ name, isDirectory });
      }

      // Sort: directories first, then alphabetically
      result.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      return {
        success: true,
        entries: result,
        content: result.map(e => e.name + (e.isDirectory ? '/' : '')).join('\n'),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        entries: [],
      };
    }
  }

  private resolveRelativePath(path: string): string {
    const rootPath = this.mount.getRootPath();
    if (path.startsWith(rootPath)) {
      return path.substring(rootPath.length).replace(/^\//, '');
    }
    return path.replace(/^\//, '');
  }
}

/**
 * CreateDirectory tool handler
 */
export class CreateDirectoryTool implements ToolHandler<ICreateDirectoryParams, ToolResult> {
  readonly name = ToolName.CreateDirectory;
  readonly definition = createDirectoryDefinition;

  constructor(private mount: ArtiMount) {}

  async execute(params: ICreateDirectoryParams): Promise<ToolResult> {
    try {
      const relativePath = this.resolveRelativePath(params.dirPath);

      await this.mount.createFolder(relativePath);

      return {
        success: true,
        content: `Created directory at ${params.dirPath}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveRelativePath(dirPath: string): string {
    const rootPath = this.mount.getRootPath();
    if (dirPath.startsWith(rootPath)) {
      return dirPath.substring(rootPath.length).replace(/^\//, '');
    }
    return dirPath.replace(/^\//, '');
  }
}

/**
 * Create all core tool handlers for a mount
 */
export function createCoreTools(mount: ArtiMount): ToolHandler[] {
  return [
    new ReadFileTool(mount),
    new CreateFileTool(mount),
    new ListDirTool(mount),
    new CreateDirectoryTool(mount),
  ];
}
