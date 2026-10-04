/**
 * Serializers: one source of truth for the tool surface (ToolDefinition),
 * two wire shapes — OpenAI function-calling and MCP-style descriptors.
 * Ported from artipod-sync lib/agent/tools.ts onto artipod's definitions.
 */

import type { ToolDefinition } from './types.js';

/** OpenAI function-call JSON shape (what tool-calling chat APIs speak). */
export interface OpenAiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition['inputSchema'];
  };
}

/** MCP-style tool descriptor (what MCPToolCall-style UIs render). */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: ToolDefinition['inputSchema'];
}

export function toOpenAiTool(def: ToolDefinition): OpenAiToolDefinition {
  return {
    type: 'function',
    function: { name: def.name, description: def.description, parameters: def.inputSchema },
  };
}

export function toOpenAiTools(defs: ToolDefinition[]): OpenAiToolDefinition[] {
  return defs.map(toOpenAiTool);
}

export function toMcpTool(def: ToolDefinition): McpToolDescriptor {
  return { name: def.name, description: def.description, inputSchema: def.inputSchema };
}

export function toMcpTools(defs: ToolDefinition[]): McpToolDescriptor[] {
  return defs.map(toMcpTool);
}
