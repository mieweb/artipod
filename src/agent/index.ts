/**
 * @artipod/core/agent — tool-calling loop, clients, and sandbox tool bindings.
 *
 * Framework-free (browser + Node). The local ONNX worker is exported as its
 * own entry (`@artipod/core/agent/local/worker`) so bundlers can target it
 * with `new Worker(new URL(...))`.
 */
export { ToolCallingLoop } from './loop.js';
export { OzwellClient } from './ozwell-client.js';
export type { OzwellClientConfig } from './ozwell-client.js';
export {
  createSandboxTools,
  toOpenAiToolDefinitions,
  toMcpToolDescriptors,
  truncateOutput,
  MAX_TOOL_OUTPUT_BYTES,
} from './tools.js';
export type {
  ChatCompletionClient,
  ChatCompletionOptions,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  McpToolDescriptor,
  MessageRole,
  TokenUsage,
  ToolCall,
  ToolCallingLoopOptions,
  ToolCallingLoopResult,
  ToolDefinition,
  ToolHandler,
  ToolResult,
} from './types.js';
export { LocalModelClient, webGpuAvailable } from './local/client.js';
export type { LocalModelClientOptions } from './local/client.js';
export {
  CURATED_MODELS,
  DEFAULT_LOCAL_MODEL,
  listLocalModels,
  modelInfo,
  type LocalModelInfo,
  type OnnxDtype,
} from './local/model-registry.js';
export { formatBytes, listCachedModels, modelIdFromCacheKey } from './local/model-cache.js';
export type { CachedModel } from './local/model-cache.js';
