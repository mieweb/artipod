/**
 * Tool definitions matching vscode-copilot-chat tool interfaces
 * This enables models trained on VS Code's tool schema to work seamlessly with artipod
 */

/**
 * Tool names matching vscode-copilot-chat ToolName enum
 * Only includes file-editing related tools, not VS Code-specific ones
 */
export enum ToolName {
  // Core file operations
  ReadFile = 'read_file',
  CreateFile = 'create_file',
  ListDirectory = 'list_dir',
  CreateDirectory = 'create_directory',

  // Edit operations
  ReplaceString = 'replace_string_in_file',
  MultiReplaceString = 'multi_replace_string_in_file',
  ApplyPatch = 'apply_patch',

  // Search operations (optional - can be implemented later)
  FindFiles = 'file_search',
  FindTextInFiles = 'grep_search',
}

/**
 * Tool category for grouping
 */
export enum ToolCategory {
  Core = 'Core',
  Edit = 'Edit',
  Search = 'Search',
}

/**
 * Map tool names to categories
 */
export const toolCategories: Record<ToolName, ToolCategory> = {
  [ToolName.ReadFile]: ToolCategory.Core,
  [ToolName.CreateFile]: ToolCategory.Core,
  [ToolName.ListDirectory]: ToolCategory.Core,
  [ToolName.CreateDirectory]: ToolCategory.Core,
  [ToolName.ReplaceString]: ToolCategory.Edit,
  [ToolName.MultiReplaceString]: ToolCategory.Edit,
  [ToolName.ApplyPatch]: ToolCategory.Edit,
  [ToolName.FindFiles]: ToolCategory.Search,
  [ToolName.FindTextInFiles]: ToolCategory.Search,
};

// ============================================================================
// Tool Parameter Interfaces - matching vscode-copilot-chat schemas exactly
// ============================================================================

/**
 * read_file parameters (v1 - with startLine/endLine)
 */
export interface IReadFileParamsV1 {
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * read_file parameters (v2 - with offset/limit)
 */
export interface IReadFileParamsV2 {
  filePath: string;
  offset?: number;
  limit?: number;
}

export type ReadFileParams = IReadFileParamsV1 | IReadFileParamsV2;

/**
 * Type guard to check if params are v2 format
 */
export function isReadFileParamsV2(params: ReadFileParams): params is IReadFileParamsV2 {
  return (params as IReadFileParamsV1).startLine === undefined;
}

/**
 * create_file parameters
 */
export interface ICreateFileParams {
  filePath: string;
  content?: string;
}

/**
 * list_dir parameters
 */
export interface IListDirParams {
  path: string;
}

/**
 * create_directory parameters
 */
export interface ICreateDirectoryParams {
  dirPath: string;
}

/**
 * replace_string_in_file parameters
 */
export interface IReplaceStringParams {
  explanation: string;
  filePath: string;
  oldString: string;
  newString: string;
}

/**
 * multi_replace_string_in_file parameters
 */
export interface IMultiReplaceStringParams {
  explanation: string;
  replacements: IReplaceStringParams[];
}

/**
 * apply_patch parameters
 */
export interface IApplyPatchParams {
  input: string;
  explanation: string;
}

/**
 * file_search parameters
 */
export interface IFileSearchParams {
  query: string;
  maxResults?: number;
}

/**
 * grep_search parameters
 */
export interface IGrepSearchParams {
  query: string;
  isRegexp?: boolean;
  includePattern?: string;
  maxResults?: number;
}

// ============================================================================
// Tool Result Types
// ============================================================================

/**
 * Generic tool result
 */
export interface ToolResult {
  success: boolean;
  content?: string;
  error?: string;
}

/**
 * File read result with metadata
 */
export interface ReadFileResult extends ToolResult {
  filePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

/**
 * Directory listing result
 */
export interface ListDirResult extends ToolResult {
  entries: Array<{
    name: string;
    isDirectory: boolean;
  }>;
}

/**
 * Edit result for replace/patch operations
 */
export interface EditResult extends ToolResult {
  filePath: string;
  linesChanged?: number;
}

/**
 * Multi-edit result
 */
export interface MultiEditResult extends ToolResult {
  results: EditResult[];
  successCount: number;
  failureCount: number;
}

// ============================================================================
// Tool Definition Schema (OpenAI function calling format)
// ============================================================================

export interface ToolParameterProperty {
  type: string;
  description: string;
  items?: ToolParameterProperty;
  properties?: Record<string, ToolParameterProperty>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    required: string[];
    properties: Record<string, ToolParameterProperty>;
  };
}

// ============================================================================
// Tool Handler Interface
// ============================================================================

/**
 * Handler for executing a tool
 */
export interface ToolHandler<TParams = unknown, TResult extends ToolResult = ToolResult> {
  readonly name: ToolName;
  readonly definition: ToolDefinition;
  execute(params: TParams): Promise<TResult>;
}
