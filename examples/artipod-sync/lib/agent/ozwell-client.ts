/**
 * Trimmed OpenAI-compatible client (Ozwell, ozwellai-api reference server,
 * OpenAI, …). Plain fetch — works in browser and Node. Streaming can come
 * later; the loop only needs non-streaming completions.
 */
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ToolDefinition,
} from './types';

export interface OzwellClientConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  /** Request timeout in ms (default 120000). */
  timeout?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

export interface ChatCompletionOptions {
  model?: string;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export class OzwellClient {
  private readonly config: Required<Omit<OzwellClientConfig, 'fetchFn'>> & {
    fetchFn: typeof fetch;
  };

  constructor(config: OzwellClientConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ''),
      apiKey: config.apiKey,
      defaultModel: config.defaultModel ?? 'gpt-4o-mini',
      timeout: config.timeout ?? 120_000,
      // Wrap: an unbound window.fetch throws "Illegal invocation" in browsers.
      fetchFn: config.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args)),
    };
  }

  async createChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {},
  ): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
    const onOuterAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });

    const request: ChatCompletionRequest = {
      model: options.model ?? this.config.defaultModel,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: false,
    };
    if (options.tools && options.tools.length > 0) {
      request.tools = options.tools;
      request.tool_choice = options.toolChoice ?? 'auto';
    }

    try {
      const response = await this.config.fetchFn(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`LLM API error (${response.status}): ${errorText.slice(0, 500)}`);
      }
      return (await response.json()) as ChatCompletionResponse;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          options.signal?.aborted ? 'Request aborted' : `Request timed out after ${this.config.timeout}ms`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
