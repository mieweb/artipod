/**
 * Apply Patch Tool Implementation
 * Uses the ported parser from vscode-copilot-chat
 */

import { ArtiMount } from '../artimount.js';
import {
  ToolName,
  ToolHandler,
  EditResult,
  IApplyPatchParams,
} from './types.js';
import { applyPatchDefinition } from './definitions.js';
import { resolvePosix } from '../pathUtils.js';
import {
  processPatch,
  applyCommit,
  SimpleTextDocument,
  DiffError,
  InvalidPatchFormatError,
  InvalidContextError,
} from './applyPatchParser.js';

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

      // Apply the commit (sequentially awaited — see applyCommit)
      await applyCommit(
        commit,
        async (filePath: string, content: string) => {
          await this.mount.write(this.resolveRelativePath(filePath), content);
          changedFiles.push(filePath);
          totalLinesChanged += content.split('\n').length;
        },
        async (filePath: string) => {
          await this.mount.remove(this.resolveRelativePath(filePath));
          changedFiles.push(filePath + ' (deleted)');
        },
        (a: string, b: string) =>
          resolvePosix('/', this.resolveRelativePath(a)) === resolvePosix('/', this.resolveRelativePath(b))
      );

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
