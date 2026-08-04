/**
 * Web Worker running in-browser ONNX inference (Transformers.js / ONNX
 * Runtime Web, WebGPU only — WASM is unusably slow at 1B+ params).
 *
 * Transformers.js is dynamic-imported from the jsDelivr CDN at runtime: its
 * bundled onnxruntime-web .mjs breaks Next 14's SWC when webpack tries to
 * bundle it into the worker chunk, and the library fetches its wasm/model
 * assets from CDNs anyway. The npm package stays as a devtime type source.
 *
 * Model weights are cached in OPFS under artipod-models/ via a custom
 * Transformers.js cache. That directory is a SIBLING of the sandbox mount
 * (artipod-fs/), so cached weights are invisible to agent bash/read_file
 * calls and are never swept up by storage migration.
 */
import { parseGeneration } from './parse-tool-calls';
import type { WorkerRequest, WorkerResponse, GenerateRequest } from './protocol';
import type { OnnxDtype } from './model-registry';
import type { ChatMessage } from '../types';

type Transformers = typeof import('@huggingface/transformers');
type PreTrainedTokenizer = import('@huggingface/transformers').PreTrainedTokenizer;
type PreTrainedModel = import('@huggingface/transformers').PreTrainedModel;

const TRANSFORMERS_CDN =
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js';

let transformersPromise: Promise<Transformers> | null = null;

function loadTransformers(): Promise<Transformers> {
  if (!transformersPromise) {
    transformersPromise = (async () => {
      // webpackIgnore: resolved by the browser at runtime, not bundled
      const mod = (await import(/* webpackIgnore: true */ TRANSFORMERS_CDN)) as Transformers;
      mod.env.useBrowserCache = false;
      mod.env.useCustomCache = true;
      mod.env.customCache = new OpfsModelCache();
      return mod;
    })();
  }
  return transformersPromise;
}

const post = (msg: WorkerResponse) => (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);

// ---------------------------------------------------------------------------
// OPFS-backed model cache (Transformers.js custom cache interface)
// ---------------------------------------------------------------------------

const MODELS_DIR = 'artipod-models';

class OpfsModelCache {
  private dir: Promise<FileSystemDirectoryHandle> | null = null;

  private getDir(): Promise<FileSystemDirectoryHandle> {
    if (!this.dir) {
      this.dir = navigator.storage
        .getDirectory()
        .then((root) => root.getDirectoryHandle(MODELS_DIR, { create: true }));
    }
    return this.dir;
  }

  // one flat file per URL; encodeURIComponent keeps it traversal-safe
  private fileName(key: string): string {
    return encodeURIComponent(key);
  }

  async match(key: string): Promise<Response | undefined> {
    try {
      const dir = await this.getDir();
      const handle = await dir.getFileHandle(this.fileName(key));
      const file = await handle.getFile();
      return new Response(file);
    } catch {
      return undefined;
    }
  }

  async put(key: string, response: Response): Promise<void> {
    try {
      const dir = await this.getDir();
      const handle = await dir.getFileHandle(this.fileName(key), { create: true });
      const writable = await handle.createWritable();
      await response.body?.pipeTo(writable);
    } catch {
      // cache write failure is non-fatal; the download still succeeded
    }
  }
}

// ---------------------------------------------------------------------------
// Model lifecycle — one loaded model at a time
// ---------------------------------------------------------------------------

interface Loaded {
  modelId: string;
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
}

let loaded: Loaded | null = null;
let loading: Promise<Loaded> | null = null;

async function ensureModel(modelId: string, dtype: OnnxDtype): Promise<Loaded> {
  if (loaded?.modelId === modelId) return loaded;
  if (loading) await loading.catch(() => undefined);
  if (loaded?.modelId === modelId) return loaded;

  if (!('gpu' in navigator)) {
    throw new Error('WebGPU is not available in this browser — local models need it.');
  }

  if (loaded) {
    await loaded.model.dispose();
    loaded = null;
  }

  const progress_callback = (info: { status: string; file?: string; progress?: number }) => {
    post({
      type: 'progress',
      status: info.status,
      file: info.file ?? modelId,
      progress: info.progress,
    });
  };

  loading = (async () => {
    const { AutoTokenizer, AutoModelForCausalLM } = await loadTransformers();
    const tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback });
    const model = await AutoModelForCausalLM.from_pretrained(modelId, {
      device: 'webgpu',
      dtype,
      progress_callback,
    });
    loaded = { modelId, tokenizer, model };
    return loaded;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Chat templates want tool-call arguments as objects, OpenAI carries strings. */
function templateMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: m.role,
        content: m.content ?? '',
        tool_calls: m.tool_calls.map((tc) => ({
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: safeParse(tc.function.arguments),
          },
        })),
      };
    }
    return { role: m.role, content: m.content ?? '', ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) };
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const stoppers = new Map<number, { interrupt(): void }>();

async function generate(req: GenerateRequest): Promise<void> {
  const { TextStreamer, InterruptableStoppingCriteria } = await loadTransformers();
  const { tokenizer, model } = await ensureModel(req.modelId, req.dtype);

  const prompt = tokenizer.apply_chat_template(templateMessages(req.messages) as never, {
    tools: (req.tools ?? null) as never,
    add_generation_prompt: true,
    tokenize: false,
  }) as string;

  const inputs = tokenizer(prompt, { return_tensors: 'pt' } as never);
  const stopper = new InterruptableStoppingCriteria();
  stoppers.set(req.id, stopper);

  try {
    const output = (await model.generate({
      ...inputs,
      max_new_tokens: req.maxNewTokens,
      do_sample: false, // greedy: small models emit better-formed tool JSON
      stopping_criteria: stopper,
      streamer: new TextStreamer(tokenizer, { skip_prompt: true, skip_special_tokens: true }),
    } as never)) as { slice(batch: null, seq: [number, null]): unknown };

    const inputLength = (inputs as { input_ids: { dims: number[] } }).input_ids.dims[1];
    // Tensor.slice(batchDim, seqDim): keep all batches, drop the prompt tokens
    const newTokens = output.slice(null, [inputLength, null]);
    const text = (tokenizer.batch_decode(newTokens as never, { skip_special_tokens: true }) as string[])[0] ?? '';

    const { content, toolCalls } = parseGeneration(text);
    post({ type: 'result', id: req.id, content, toolCalls });
  } finally {
    stoppers.delete(req.id);
  }
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type === 'abort') {
    stoppers.get(msg.id)?.interrupt();
    return;
  }
  try {
    await generate(msg);
  } catch (e) {
    post({ type: 'error', id: msg.id, message: e instanceof Error ? e.message : String(e) });
  }
};
