/**
 * Re-export shim — moved to @artipod/core/agent (plan Phase 2; one release).
 * NOTE: the tool surface changed with the move (plan §2 collision #1): the
 * old read_file/write_file/list_files shapes are gone; createSandboxTools now
 * serves the VS Code-schema pod file tools + bash.
 */
export {
  createSandboxTools,
  toOpenAiToolDefinitions,
  toMcpToolDescriptors,
  truncateOutput,
  MAX_TOOL_OUTPUT_BYTES,
} from '@artipod/core/agent';
