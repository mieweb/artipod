/**
 * Which models are already in the OPFS weight cache (artipod-models/).
 * Cache files are named encodeURIComponent(<download URL>), so decoding the
 * names and grouping by HF repo id tells us what's downloaded.
 */

const MODELS_DIR = 'artipod-models';

/** huggingface.co/<org>/<name>/resolve/... → "<org>/<name>"; null for runtime assets. */
export function modelIdFromCacheKey(decodedUrl: string): string | null {
  try {
    const url = new URL(decodedUrl);
    if (url.hostname !== 'huggingface.co') return null;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 4 || segments[2] !== 'resolve') return null;
    return `${segments[0]}/${segments[1]}`;
  } catch {
    return null;
  }
}

const isWeightsFile = (decodedUrl: string) => /\.onnx(_data.*)?$/.test(decodedUrl);

export interface CachedModel {
  bytes: number;
  /** True once an .onnx/.onnx_data file is present (config-only ≠ downloaded). */
  hasWeights: boolean;
}

export async function listCachedModels(): Promise<Map<string, CachedModel>> {
  const cached = new Map<string, CachedModel>();
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return cached;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(MODELS_DIR);
    const entries = (dir as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries();
    while (true) {
      const { done, value } = await entries.next();
      if (done) break;
      const [name, handle] = value;
      if (handle.kind !== 'file') continue;
      const decoded = decodeURIComponent(name);
      const modelId = modelIdFromCacheKey(decoded);
      if (!modelId) continue;
      const size = (await (handle as FileSystemFileHandle).getFile()).size;
      const entry = cached.get(modelId) ?? { bytes: 0, hasWeights: false };
      entry.bytes += size;
      entry.hasWeights = entry.hasWeights || isWeightsFile(decoded);
      cached.set(modelId, entry);
    }
  } catch {
    // no cache dir yet
  }
  return cached;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} kB`;
}
