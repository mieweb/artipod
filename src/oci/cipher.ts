/**
 * Chunked-AEAD blob format (docs/encryption.md#at-rest-format, normative):
 * AES-256-GCM, ~4 MiB chunks, unique nonce + tag per chunk. Two identities
 * per blob: the plaintext digest (diff ID — dedup/integrity inside a pod)
 * and the ciphertext digest (what stores, registries and relays address).
 *
 * Phase 4 ships the FORMAT behind a per-pod opt-in (default off); keyring,
 * leases and envelopes arrive in Phase 6.5 — callers hold the CryptoKey for
 * now. Chunking preserves random access and bounds browser memory; the
 * chunk table is not secret (sizes/nonces), the data is.
 */

import { sha256, verifyDigest, type Digest } from './digest.js';

export const ENCRYPTED_LAYER_MEDIA_TYPE = 'application/vnd.artipod.volume.layer.v1.chunked+encrypted';
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

const MAGIC = new TextEncoder().encode('APODENC1');
const GCM_TAG_BYTES = 16;

export interface ChunkedCipherHeader {
  formatVersion: 1;
  cipher: 'aes-256-gcm';
  chunkSize: number;
  plaintextSize: number;
  /** base64 nonce per chunk, in order. */
  nonces: string[];
}

export interface EncryptedBlob {
  bytes: Uint8Array;
  plaintextDigest: Digest;
  ciphertextDigest: Digest;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function generateBlobKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Test/dev helper — real key custody is Phase 6.5's keyring. */
export async function importBlobKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptBlob(
  plaintext: Uint8Array,
  key: CryptoKey,
  chunkSize = DEFAULT_CHUNK_SIZE,
): Promise<EncryptedBlob> {
  const chunks: Uint8Array[] = [];
  const nonces: string[] = [];
  for (let offset = 0; offset < plaintext.length || offset === 0; offset += chunkSize) {
    const chunk = plaintext.subarray(offset, Math.min(offset + chunkSize, plaintext.length));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, chunk as BufferSource),
    );
    chunks.push(encrypted);
    nonces.push(b64(nonce));
    if (plaintext.length === 0) break;
  }

  const header: ChunkedCipherHeader = {
    formatVersion: 1,
    cipher: 'aes-256-gcm',
    chunkSize,
    plaintextSize: plaintext.length,
    nonces,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const total = MAGIC.length + 4 + headerBytes.length + chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  bytes.set(MAGIC, 0);
  new DataView(bytes.buffer).setUint32(MAGIC.length, headerBytes.length, false);
  bytes.set(headerBytes, MAGIC.length + 4);
  let at = MAGIC.length + 4 + headerBytes.length;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }

  return { bytes, plaintextDigest: await sha256(plaintext), ciphertextDigest: await sha256(bytes) };
}

export function isEncryptedBlob(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

/**
 * Decrypt a chunked blob; GCM authentication makes any tampering throw.
 * Optionally verifies the recovered plaintext against an expected diff ID.
 */
export async function decryptBlob(
  bytes: Uint8Array,
  key: CryptoKey,
  expectedPlaintextDigest?: Digest,
): Promise<Uint8Array> {
  if (!isEncryptedBlob(bytes)) throw new Error('Not an artipod encrypted blob (bad magic)');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset).getUint32(MAGIC.length, false);
  const headerStart = MAGIC.length + 4;
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength)),
  ) as ChunkedCipherHeader;
  if (header.formatVersion !== 1 || header.cipher !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted blob format');
  }

  const out = new Uint8Array(header.plaintextSize);
  let readAt = headerStart + headerLength;
  let writeAt = 0;
  for (const [i, nonceB64] of header.nonces.entries()) {
    const plainChunk = Math.min(header.chunkSize, header.plaintextSize - writeAt);
    const cipherChunk = plainChunk + GCM_TAG_BYTES;
    const chunk = bytes.subarray(readAt, readAt + cipherChunk);
    let plain: ArrayBuffer;
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(nonceB64) as BufferSource }, key, chunk as BufferSource);
    } catch {
      throw new Error(`Encrypted blob failed authentication at chunk ${i} — tampered or wrong key`);
    }
    out.set(new Uint8Array(plain), writeAt);
    readAt += cipherChunk;
    writeAt += plainChunk;
  }

  if (expectedPlaintextDigest) await verifyDigest(out, expectedPlaintextDigest, 'decrypted blob');
  return out;
}
