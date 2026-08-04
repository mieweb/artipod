/**
 * In-browser ONNX model registry: curated tool-capable defaults merged with
 * a live query of the Hugging Face Hub (the de-facto ONNX model registry —
 * CORS-enabled REST API), so the dropdown stays current without shipping a
 * hardcoded list.
 */

/** Quantizations Transformers.js accepts for ONNX models. */
export type OnnxDtype = 'auto' | 'q4' | 'q4f16' | 'q8' | 'int8' | 'uint8' | 'fp16' | 'fp32';

export interface LocalModelInfo {
  /** HF repo id, e.g. onnx-community/Qwen2.5-1.5B-Instruct */
  id: string;
  label: string;
  /** Approximate q4 download size, shown in the picker. */
  approxSize?: string;
  /** ONNX quantization to request. */
  dtype: OnnxDtype;
  curated: boolean;
}

export const CURATED_MODELS: LocalModelInfo[] = [
  {
    id: 'onnx-community/Qwen2.5-1.5B-Instruct',
    label: 'Qwen2.5 1.5B Instruct (best small tool-caller)',
    approxSize: '~1.1 GB',
    dtype: 'q4',
    curated: true,
  },
  {
    id: 'onnx-community/Qwen2.5-0.5B-Instruct',
    label: 'Qwen2.5 0.5B Instruct (fastest, weakest)',
    approxSize: '~0.35 GB',
    dtype: 'q4',
    curated: true,
  },
  {
    id: 'onnx-community/Llama-3.2-1B-Instruct-ONNX',
    label: 'Llama 3.2 1B Instruct',
    approxSize: '~0.7 GB',
    dtype: 'q4',
    curated: true,
  },
];

export const DEFAULT_LOCAL_MODEL = CURATED_MODELS[0].id;

const HUB_QUERY =
  'https://huggingface.co/api/models?author=onnx-community&pipeline_tag=text-generation&sort=downloads&direction=-1&limit=30';

interface HubModel {
  id: string;
}

/** Curated list first, then popular Hub extras; Hub failure degrades to curated. */
export async function listLocalModels(fetchFn: typeof fetch = fetch): Promise<LocalModelInfo[]> {
  const models = [...CURATED_MODELS];
  try {
    const res = await fetchFn(HUB_QUERY);
    if (res.ok) {
      const hub = (await res.json()) as HubModel[];
      const known = new Set(models.map((m) => m.id));
      for (const { id } of hub) {
        // only instruct/chat-style repos are useful for tool calling
        if (known.has(id) || !/instruct|chat|it-/i.test(id)) continue;
        models.push({ id, label: id.replace('onnx-community/', ''), dtype: 'q4', curated: false });
      }
    }
  } catch {
    // offline / rate-limited: curated list is the fallback
  }
  return models;
}

export function modelInfo(id: string, models: LocalModelInfo[]): LocalModelInfo {
  return models.find((m) => m.id === id) ?? { id, label: id, dtype: 'q4', curated: false };
}
