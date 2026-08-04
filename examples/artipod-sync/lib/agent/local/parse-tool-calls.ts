/**
 * Parse tool calls out of small-model chat output into OpenAI shape.
 * Tolerates the two formats our supported templates emit:
 *   - Qwen:  <tool_call>{"name": "...", "arguments": {...}}</tool_call>
 *   - Llama: a bare JSON object {"name": "...", "parameters": {...}}
 */
import type { ToolCall } from '../types';

export interface ParsedGeneration {
  content: string;
  toolCalls: ToolCall[];
}

let counter = 0;
const nextId = () => `local_call_${++counter}_${Date.now().toString(36)}`;

interface RawCall {
  name?: unknown;
  arguments?: unknown;
  parameters?: unknown;
}

function toToolCall(raw: RawCall): ToolCall | null {
  if (typeof raw?.name !== 'string' || !raw.name) return null;
  const args = raw.arguments ?? raw.parameters ?? {};
  return {
    id: nextId(),
    type: 'function',
    function: {
      name: raw.name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

const TOOL_CALL_BLOCK = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

export function parseGeneration(output: string): ParsedGeneration {
  const toolCalls: ToolCall[] = [];

  const content = output
    .replace(TOOL_CALL_BLOCK, (_match, body: string) => {
      try {
        const call = toToolCall(JSON.parse(body));
        if (call) toolCalls.push(call);
      } catch {
        // malformed block: keep it visible as content instead of dropping it
        return _match;
      }
      return '';
    })
    .trim();

  if (toolCalls.length === 0 && content.startsWith('{') && content.endsWith('}')) {
    // Llama-style bare JSON tool call
    try {
      const call = toToolCall(JSON.parse(content));
      if (call) return { content: '', toolCalls: [call] };
    } catch {
      // plain JSON-looking prose: fall through
    }
  }

  return { content, toolCalls };
}
