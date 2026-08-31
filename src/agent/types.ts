/**
 * OpenAI-compatible tool-calling types, ported from ozwell-artipod
 * (transport-clean; browser + server). Framework-free like lib/sandbox/.
 */

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: MessageRole;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolParameterProperty {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: ToolParameterProperty;
}

/** OpenAI function-call tool definition. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, ToolParameterProperty>;
      required?: string[];
    };
  };
}

/** MCP-style tool descriptor (what MCPToolCall-style UIs render). */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, ToolParameterProperty>;
    required?: string[];
  };
}

export interface ToolResult {
  success: boolean;
  content: string;
  error?: string;
}

export interface ToolHandler {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionOptions {
  model?: string;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Anything the loop can talk to: the remote OzwellClient or an in-browser model. */
export interface ChatCompletionClient {
  createChatCompletion(
    messages: ChatMessage[],
    options?: ChatCompletionOptions,
  ): Promise<ChatCompletionResponse>;
}

export interface ToolCallingLoopOptions {
  maxIterations?: number;
  systemPrompt?: string;
  signal?: AbortSignal;
  onAssistantMessage?: (content: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onToolResult?: (toolCall: ToolCall, result: ToolResult) => void;
}

export interface ToolCallingLoopResult {
  content: string;
  messages: ChatMessage[];
  iterations: number;
  usage: TokenUsage;
}
