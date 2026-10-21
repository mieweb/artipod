/** Consumer bundler adapter for the zlib surface used by just-bash 3.4.2. */
import { gzipSync as gzip, Gunzip } from 'fflate';

export const constants = { Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1 };
const limit = options => options?.maxOutputLength ?? 0x7fffffff;
export function gzipSync(bytes, options = {}) {
  const result = gzip(bytes, { level: options.level === -1 ? undefined : options.level });
  if (result.length > limit(options)) throw new RangeError('Gzip output exceeds maxOutputLength');
  return result;
}
export function gunzipSync(bytes, options = {}) {
  const chunks = [];
  let size = 0;
  const stream = new Gunzip(chunk => {
    size += chunk.length;
    if (size > limit(options)) throw new RangeError('Gunzip output exceeds maxOutputLength');
    chunks.push(chunk);
  });
  stream.push(bytes, true);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
