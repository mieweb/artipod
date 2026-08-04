/**
 * LocalModelClient — ChatCompletionClient over the ONNX worker, so
 * ToolCallingLoop works identically with in-browser models. WebGPU only.
 */
import type {
  ChatCompletionClient,
  ChatCompletionOptions,
  ChatCompletionResponse,
  ChatMessage,
} from '../types';
import type { ResultEvent, WorkerRequest, WorkerResponse } from './protocol';
import type { OnnxDtype } from './model-registry';

export interface LocalModelClientOptions {
  modelId: string;
  dtype?: OnnxDtype;
  /** Download / load progress for the UI. */
  onProgress?: (status: string, file: string, progress?: number) => void;
}

export function webGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

interface Pending {
  resolve: (r: ResultEvent) => void;
  reject: (e: Error) => void;
}

export class LocalModelClient implements ChatCompletionClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly opts: LocalModelClientOptions) {}

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        if (msg.type === 'progress') {
          this.opts.onProgress?.(msg.status, msg.file, msg.progress);
          return;
        }
        const pending = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
        if (!pending) return;
        this.pending.delete(msg.id as number);
        if (msg.type === 'result') pending.resolve(msg);
        else pending.reject(new Error(msg.message));
      };
      this.worker.onerror = (e) => {
        this.pending.forEach((p) => p.reject(new Error(e.message || 'local model worker crashed')));
        this.pending.clear();
      };
    }
    return this.worker;
  }

  async createChatCompletion(
    messages: ChatMessage[],
    options: ChatCompletionOptions = {},
  ): Promise<ChatCompletionResponse> {
    if (!webGpuAvailable()) {
      throw new Error('WebGPU is not available in this browser — local ONNX models need it.');
    }

    const id = this.nextId++;
    const request: WorkerRequest = {
      type: 'generate',
      id,
      modelId: this.opts.modelId,
      dtype: this.opts.dtype ?? 'q4',
      messages,
      tools: options.tools,
      maxNewTokens: options.maxTokens ?? 1024,
    };

    const worker = this.getWorker();
    const onAbort = () => worker.postMessage({ type: 'abort', id } satisfies WorkerRequest);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await new Promise<ResultEvent>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        worker.postMessage(request);
      });

      const message: ChatMessage = {
        role: 'assistant',
        content: result.toolCalls.length && !result.content ? null : result.content,
        ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
      };
      return {
        id: `local-${id}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: this.opts.modelId,
        choices: [
          {
            index: 0,
            message,
            finish_reason: result.toolCalls.length ? 'tool_calls' : 'stop',
          },
        ],
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}
