/**
 * Gzip decompression for layer blobs: `DecompressionStream` (browsers +
 * Node ≥18) with a dynamic `fflate` fallback (optional peer) — just-bash's
 * gzip is Node-only by design, so it is deliberately not reused here.
 */

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof globalThis.DecompressionStream === 'function') {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  try {
    const { gunzipSync } = await import('fflate');
    return gunzipSync(bytes);
  } catch (e) {
    throw new Error(
      `gunzip: no DecompressionStream in this environment and the fflate fallback is unavailable (${(e as Error).message})`,
    );
  }
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}
