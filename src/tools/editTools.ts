/**
 * String replacement tool implementations matching vscode-copilot-chat interfaces
 */

import { ArtiMount } from '../artimount';
import {
  ToolName,
  ToolHandler,
  EditResult,
  MultiEditResult,
  IReplaceStringParams,
  IMultiReplaceStringParams,
} from './types';
import {
  replaceStringDefinition,
  multiReplaceStringDefinition,
} from './definitions';

/**
 * Error thrown when oldString is not found in the file
 */
export class NoMatchError extends Error {
  constructor(message: string, public readonly filePath: string) {
    super(message);
    this.name = 'NoMatchError';
  }
}

/**
 * Error thrown when oldString matches multiple locations
 */
export class MultipleMatchError extends Error {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly matchCount: number
  ) {
    super(message);
    this.name = 'MultipleMatchError';
  }
}

/**
 * Error thrown when oldString equals newString (no change)
 */
export class NoChangeError extends Error {
  constructor(message: string, public readonly filePath: string) {
    super(message);
    this.name = 'NoChangeError';
  }
}

/**
 * Count occurrences of a substring in a string
 */
function countOccurrences(content: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = content.indexOf(search, pos)) !== -1) {
    count++;
    pos += 1; // Move past this match to find overlapping matches
  }
  return count;
}

/**
 * Normalize line endings to \n
 */
function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/**
 * Perform a single string replacement in file content
 * Returns the new content and the number of lines changed
 */
function performReplacement(
  content: string,
  oldString: string,
  newString: string,
  filePath: string
): { newContent: string; linesChanged: number } {
  // Normalize line endings for consistent matching
  const normalizedContent = normalizeLineEndings(content);
  const normalizedOld = normalizeLineEndings(oldString);
  const normalizedNew = normalizeLineEndings(newString);

  // Check for no-op
  if (normalizedOld === normalizedNew) {
    throw new NoChangeError('Input and output are identical', filePath);
  }

  // Count occurrences
  const occurrences = countOccurrences(normalizedContent, normalizedOld);

  if (occurrences === 0) {
    // Try to provide helpful error message
    const trimmedOld = normalizedOld.trim();
    const trimmedOccurrences = countOccurrences(normalizedContent, trimmedOld);
    
    if (trimmedOccurrences > 0) {
      throw new NoMatchError(
        `The oldString was not found in the file, but a similar string was found (ignoring leading/trailing whitespace). ` +
        `Make sure to match the exact whitespace and indentation. File: ${filePath}`,
        filePath
      );
    }

    // Check if any line from oldString exists
    const oldLines = normalizedOld.split('\n');
    const foundLines = oldLines.filter(line => 
      line.trim() && normalizedContent.includes(line.trim())
    );

    if (foundLines.length > 0 && foundLines.length < oldLines.length) {
      throw new NoMatchError(
        `The oldString was not found as a complete match. Some lines were found but not all. ` +
        `The file may have been modified. File: ${filePath}`,
        filePath
      );
    }

    throw new NoMatchError(
      `The oldString was not found in the file. Make sure the string matches exactly ` +
      `including all whitespace, indentation, and newlines. File: ${filePath}`,
      filePath
    );
  }

  if (occurrences > 1) {
    throw new MultipleMatchError(
      `The oldString was found ${occurrences} times in the file. ` +
      `Include more context (at least 3 lines before and after) to uniquely identify the location. ` +
      `File: ${filePath}`,
      filePath,
      occurrences
    );
  }

  // Perform the replacement
  const newContent = normalizedContent.replace(normalizedOld, normalizedNew);

  // Count lines changed
  const oldLineCount = normalizedOld.split('\n').length;
  const newLineCount = normalizedNew.split('\n').length;
  const linesChanged = Math.abs(newLineCount - oldLineCount) + 
    Math.min(oldLineCount, newLineCount);

  return { newContent, linesChanged };
}

/**
 * ReplaceString tool handler
 */
export class ReplaceStringTool implements ToolHandler<IReplaceStringParams, EditResult> {
  readonly name = ToolName.ReplaceString;
  readonly definition = replaceStringDefinition;

  constructor(private mount: ArtiMount) {}

  async execute(params: IReplaceStringParams): Promise<EditResult> {
    try {
      const relativePath = this.resolveRelativePath(params.filePath);

      // Read current file content
      const content = await this.mount.read(relativePath);

      // Perform replacement
      const { newContent, linesChanged } = performReplacement(
        content,
        params.oldString,
        params.newString,
        params.filePath
      );

      // Write updated content
      await this.mount.write(relativePath, newContent);

      return {
        success: true,
        content: `Successfully replaced string in ${params.filePath}`,
        filePath: params.filePath,
        linesChanged,
      };
    } catch (error) {
      if (error instanceof NoMatchError || 
          error instanceof MultipleMatchError || 
          error instanceof NoChangeError) {
        return {
          success: false,
          error: error.message,
          filePath: params.filePath,
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        filePath: params.filePath,
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
 * MultiReplaceString tool handler
 */
export class MultiReplaceStringTool implements ToolHandler<IMultiReplaceStringParams, MultiEditResult> {
  readonly name = ToolName.MultiReplaceString;
  readonly definition = multiReplaceStringDefinition;

  constructor(private mount: ArtiMount) {}

  async execute(params: IMultiReplaceStringParams): Promise<MultiEditResult> {
    if (!params.replacements || !Array.isArray(params.replacements)) {
      return {
        success: false,
        error: 'Invalid input: replacements array is required',
        results: [],
        successCount: 0,
        failureCount: 0,
      };
    }

    const results: EditResult[] = [];
    let successCount = 0;
    let failureCount = 0;

    // Group replacements by file for efficiency
    const fileContents = new Map<string, string>();

    // Process each replacement sequentially
    for (let i = 0; i < params.replacements.length; i++) {
      const replacement = params.replacements[i];
      
      try {
        const relativePath = this.resolveRelativePath(replacement.filePath);

        // Get current content (may have been modified by previous replacements)
        let content: string;
        if (fileContents.has(relativePath)) {
          content = fileContents.get(relativePath)!;
        } else {
          content = await this.mount.read(relativePath);
        }

        // Perform replacement
        const { newContent, linesChanged } = performReplacement(
          content,
          replacement.oldString,
          replacement.newString,
          replacement.filePath
        );

        // Store updated content for subsequent replacements
        fileContents.set(relativePath, newContent);

        results.push({
          success: true,
          content: `Successfully replaced string at index ${i}`,
          filePath: replacement.filePath,
          linesChanged,
        });
        successCount++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push({
          success: false,
          error: `Replacement at index ${i} failed: ${errorMessage}`,
          filePath: replacement.filePath,
        });
        failureCount++;
      }
    }

    // Write all modified files
    for (const [relativePath, content] of fileContents) {
      try {
        await this.mount.write(relativePath, content);
      } catch (error) {
        // Find and update the result for this file
        const errorMessage = error instanceof Error ? error.message : String(error);
        for (const result of results) {
          if (result.success && this.resolveRelativePath(result.filePath) === relativePath) {
            result.success = false;
            result.error = `Failed to write file: ${errorMessage}`;
            successCount--;
            failureCount++;
            break;
          }
        }
      }
    }

    const allSucceeded = failureCount === 0;
    return {
      success: allSucceeded,
      content: allSucceeded 
        ? `All ${successCount} replacements succeeded`
        : `${successCount} replacements succeeded, ${failureCount} failed`,
      results,
      successCount,
      failureCount,
    };
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
 * Create all edit tool handlers for a mount
 */
export function createEditTools(mount: ArtiMount): ToolHandler[] {
  return [
    new ReplaceStringTool(mount),
    new MultiReplaceStringTool(mount),
  ];
}
