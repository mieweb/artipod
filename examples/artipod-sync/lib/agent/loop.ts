/**
 * ToolCallingLoop — ported from ozwell-artipod, browser-safe, with abort.
 *
 * 1. Send messages to the LLM
 * 2. If it returns tool calls, execute them (against the sandbox)
 * 3. Feed tool results back
 * 4. Repeat until a final text response (or maxIterations / abort)
 */
import { OzwellClient } from './ozwell-client';
import type {
  ChatMessage,
  ToolCall,
  ToolCallingLoopOptions,
  ToolCallingLoopResult,
  ToolDefinition,
  ToolHandler,
  ToolResult,
} from './types';

const DEFAULT_MAX_ITERATIONS = 10;

export class ToolCallingLoop {
  private readonly toolDefinitions: ToolDefinition[];

  constructor(
    private readonly client: OzwellClient,
    private readonly tools: Map<string, ToolHandler>,
  ) {
    this.toolDefinitions = Array.from(tools.values()).map((t) => t.definition);
  }

  async run(userMessage: string, options: ToolCallingLoopOptions = {}): Promise<ToolCallingLoopResult> {
    const messages: ChatMessage[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    messages.push({ role: 'user', content: userMessage });
    return this.runWithHistory(messages, options);
  }

  /** Run the loop over an existing conversation (multi-turn). Mutates nothing; returns the new message list. */
  async runWithHistory(
    history: ChatMessage[],
    options: ToolCallingLoopOptions = {},
  ): Promise<ToolCallingLoopResult> {
    const { maxIterations = DEFAULT_MAX_ITERATIONS, signal, onAssistantMessage, onToolCall, onToolResult } = options;

    const messages = [...history];
    let iterations = 0;
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    while (iterations < maxIterations) {
      if (signal?.aborted) throw new Error('Agent run aborted');
      iterations++;

      const response = await this.client.createChatCompletion(messages, {
        tools: this.toolDefinitions,
        toolChoice: 'auto',
        signal,
      });

      if (response.usage) {
        usage.prompt_tokens += response.usage.prompt_tokens;
        usage.completion_tokens += response.usage.completion_tokens;
        usage.total_tokens += response.usage.total_tokens;
      }

      const choice = response.choices[0];
      if (!choice) throw new Error('No response choice returned from LLM');

      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        const content = assistantMessage.content ?? '';
        onAssistantMessage?.(content);
        return { content, messages, iterations, usage };
      }

      // Content alongside tool calls is still worth surfacing.
      if (assistantMessage.content) onAssistantMessage?.(assistantMessage.content);

      for (const toolCall of toolCalls) {
        if (signal?.aborted) throw new Error('Agent run aborted');
        onToolCall?.(toolCall);
        const result = await this.executeToolCall(toolCall, signal);
        onToolResult?.(toolCall, result);
        messages.push({
          role: 'tool',
          content: result.success ? result.content : `Error: ${result.error}`,
          tool_call_id: toolCall.id,
        });
      }
    }

    throw new Error(`Maximum iterations (${maxIterations}) reached without a final response`);
  }

  private async executeToolCall(toolCall: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    const handler = this.tools.get(toolName);
    if (!handler) {
      return {
        success: false,
        content: '',
        error: `Unknown tool: ${toolName}. Available tools: ${Array.from(this.tools.keys()).join(', ')}`,
      };
    }
    try {
      const args = JSON.parse(toolCall.function.arguments || '{}');
      return await handler.execute(args, signal);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return {
          success: false,
          content: '',
          error: `Invalid JSON arguments for tool ${toolName}: ${toolCall.function.arguments}`,
        };
      }
      return {
        success: false,
        content: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.toolDefinitions;
  }
}
