/**
 * Digests — sha256 via WebCrypto (browsers + Node ≥20). Digest strings use
 * the OCI form `sha256:<hex>`; blobs are always verifiable against them.
 */

export type Digest = `sha256:${string}`;

export async function sha256(bytes: Uint8Array): Promise<Digest> {
  const hash = await globalThis.crypto.subtle.digest(
    'SHA-256',
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return `sha256:${toHex(new Uint8Array(hash))}`;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function isDigest(s: string): s is Digest {
  return /^sha256:[0-9a-f]{64}$/.test(s);
}

export function digestHex(digest: Digest): string {
  return digest.slice('sha256:'.length);
}

/** Throws when bytes don't hash to `expected` — the tamper gate. */
export async function verifyDigest(bytes: Uint8Array, expected: Digest, what = 'blob'): Promise<void> {
  const actual = await sha256(bytes);
  if (actual !== expected) {
    throw new Error(`Digest mismatch for ${what}: expected ${expected}, got ${actual} — refusing tampered content`);
  }
}
