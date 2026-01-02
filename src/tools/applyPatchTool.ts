/**
 * Apply Patch Tool Implementation
 * Uses the ported parser from vscode-copilot-chat
 */

import { ArtiMount } from '../artimount';
import {
  ToolName,
  ToolHandler,
  EditResult,
  IApplyPatchParams,
} from './types';
import { applyPatchDefinition } from './definitions';
import {
  processPatch,
  applyCommit,
  SimpleTextDocument,
  DiffError,
  InvalidPatchFormatError,
  InvalidContextError,
  ActionType,
} from './applyPatchParser';

/**
 * ApplyPatch tool handler
 */
export class ApplyPatchTool implements ToolHandler<IApplyPatchParams, EditResult> {
  readonly name = ToolName.ApplyPatch;
  readonly definition = applyPatchDefinition;

  constructor(private mount: ArtiMount) {}

  async execute(params: IApplyPatchParams): Promise<EditResult> {
    try {
      // Validate input
      if (!params.input || typeof params.input !== 'string') {
        return {
          success: false,
          error: 'Invalid input: patch text is required',
          filePath: '',
        };
      }

      const rootPath = this.mount.getRootPath();

      // Process the patch - load files and parse
      const commit = await processPatch(
        params.input,
        async (filePath: string) => {
          const relativePath = this.resolveRelativePath(filePath);
          const content = await this.mount.read(relativePath);
          const languageId = this.getLanguageId(filePath);
          return new SimpleTextDocument(content, languageId);
        }
      );

      // Track changes for result
      const changedFiles: string[] = [];
      let totalLinesChanged = 0;

      // Apply the commit
      applyCommit(
        commit,
        // Write function
        async (filePath: string, content: string) => {
          const relativePath = this.resolveRelativePath(filePath);
          await this.mount.write(relativePath, content);
          changedFiles.push(filePath);
          totalLinesChanged += content.split('\n').length;
        },
        // Remove function (for delete operations)
        async (filePath: string) => {
          // For now, we don't support file deletion in ArtiMount
          // This would require adding a delete method
          changedFiles.push(filePath + ' (deleted)');
        }
      );

      // Write files from commit
      for (const [filePath, change] of Object.entries(commit.changes)) {
        const relativePath = this.resolveRelativePath(filePath);
        
        if (change.type === ActionType.ADD || change.type === ActionType.UPDATE) {
          const content = change.newContent ?? '';
          await this.mount.write(relativePath, content);
          changedFiles.push(filePath);
          totalLinesChanged += content.split('\n').length;
        }
        // Note: DELETE operations would require a delete method on ArtiMount
      }

      return {
        success: true,
        content: `Successfully applied patch to ${changedFiles.length} file(s): ${changedFiles.join(', ')}`,
        filePath: changedFiles.join(', '),
        linesChanged: totalLinesChanged,
      };
    } catch (error) {
      if (error instanceof InvalidPatchFormatError) {
        return {
          success: false,
          error: `Invalid patch format: ${error.message}`,
          filePath: '',
        };
      }

      if (error instanceof InvalidContextError) {
        return {
          success: false,
          error: `Could not find matching context in file: ${error.message}. ` +
            `Make sure the context lines match exactly, including whitespace.`,
          filePath: error.file,
        };
      }

      if (error instanceof DiffError) {
        return {
          success: false,
          error: `Patch error: ${error.message}`,
          filePath: '',
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        filePath: '',
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

  private getLanguageId(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const languageMap: Record<string, string> = {
      'md': 'markdown',
      'markdown': 'markdown',
      'ts': 'typescript',
      'tsx': 'typescriptreact',
      'js': 'javascript',
      'jsx': 'javascriptreact',
      'json': 'json',
      'py': 'python',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
      'cs': 'csharp',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'yaml': 'yaml',
      'yml': 'yaml',
      'xml': 'xml',
      'sh': 'shellscript',
      'bash': 'shellscript',
      'zsh': 'shellscript',
    };
    return languageMap[ext] || 'plaintext';
  }
}

/**
 * Create apply patch tool for a mount
 */
export function createApplyPatchTool(mount: ArtiMount): ApplyPatchTool {
  return new ApplyPatchTool(mount);
}
