/**
 * Tools module - vscode-copilot-chat compatible tool implementations
 * 
 * This module provides file editing and reading tools with identical
 * interfaces to vscode-copilot-chat, enabling models trained on VS Code's
 * tool schema to work seamlessly with artipod containers.
 */

import { ArtiMount } from '../artimount.js';
import { ToolHandler, ToolName, ToolDefinition, ToolResult } from './types.js';
import { createCoreTools } from './coreTools.js';
import { createEditTools } from './editTools.js';
import { createApplyPatchTool } from './applyPatchTool.js';
import { allToolDefinitions } from './definitions.js';

// Re-export types
export * from './types.js';
export * from './definitions.js';

// Re-export individual mount-level tools
export { ReadFileTool, CreateFileTool, ListDirTool, CreateDirectoryTool } from './coreTools.js';
export { ReplaceStringTool, MultiReplaceStringTool, NoMatchError, MultipleMatchError, NoChangeError } from './editTools.js';
export { ApplyPatchTool } from './applyPatchTool.js';
export * from './applyPatchParser.js';

// Re-export pod-level tools
export { RunTerminalTool, PodToolRegistry, createPodToolRegistry, createPodTools } from './podTools.js';
export type { PodToolRegistryOptions } from './podTools.js';

// bash tool + executor contract
export { BashTool, bashDefinition, containerBashExecutor } from './bashTool.js';
export type { BashExecutor, BashExecutionResult, BashToolResult } from './bashTool.js';

// Pod-level file tools over a declarative mount table (no prefix scheme)
export { PodPathResolver, createPodFileTools } from './podFileTools.js';
export type { MountTableEntry } from './podFileTools.js';

// Output truncation (16 KiB head+tail, ported from artipod-sync)
export { MAX_TOOL_OUTPUT_BYTES, truncateOutput } from './truncation.js';

// OpenAI + MCP serializers
export { toOpenAiTool, toOpenAiTools, toMcpTool, toMcpTools } from './serializers.js';
export type { OpenAiToolDefinition, McpToolDescriptor } from './serializers.js';

/**
 * Tool registry for mount-level operations (file reading/editing)
 */
export class MountToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();

  constructor(mount: ArtiMount) {
    // Register all core tools
    for (const tool of createCoreTools(mount)) {
      this.register(tool);
    }

    // Register all edit tools
    for (const tool of createEditTools(mount)) {
      this.register(tool);
    }

    // Register apply patch tool
    this.register(createApplyPatchTool(mount));
  }

  /**
   * Register a tool handler
   */
  register(tool: ToolHandler): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get a tool handler by name
   */
  get(name: ToolName | string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool handlers
   */
  getAll(): ToolHandler[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get all tool definitions (for OpenAI function calling format)
   */
  getDefinitions(): ToolDefinition[] {
    return this.getAll().map(tool => tool.definition);
  }

  /**
   * Execute a tool by name with given parameters
   */
  async execute(name: ToolName | string, params: unknown): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${name}`,
      };
    }

    try {
      return await tool.execute(params);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if a tool is registered
   */
  has(name: ToolName | string): boolean {
    return this.tools.has(name);
  }
}

/**
 * Create a mount tool registry for a mount
 */
export function createToolRegistry(mount: ArtiMount): MountToolRegistry {
  return new MountToolRegistry(mount);
}

/**
 * Create all tools for a mount (returns array of handlers)
 */
export function createAllTools(mount: ArtiMount): ToolHandler[] {
  return [
    ...createCoreTools(mount),
    ...createEditTools(mount),
    createApplyPatchTool(mount),
  ];
}

/**
 * Get tool definitions for OpenAI function calling format
 * These match vscode-copilot-chat schemas exactly
 */
export function getToolDefinitions(): ToolDefinition[] {
  return allToolDefinitions;
}
