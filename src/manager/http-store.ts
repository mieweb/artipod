/**
 * HttpPodStore — the browser-side client for a manager's sync routes
 * (plan Phase 6). Wire shape (implemented by the artipod-sync app):
 *
 *   HEAD/GET <base>/blobs/<digest>          → 200 bytes | 404
 *   PUT      <base>/blobs/<digest>  body    → 201
 *   GET      <base>/refs                    → StoredRef[]
 *   GET      <base>/refs?name=<ref>         → StoredRef | 404
 *   PUT      <base>/refs            body    → 201 ({ref, manifestDigest, mediaType})
 *
 * Digests verify locally on both sides, so the wire never needs trust.
 */

import { sha256, verifyDigest, type Digest } from '../oci/digest.js';
import type { StoredRef } from '../oci/store.js';
import type { PodStore } from './pod-store.js';

export class HttpPodStore implements PodStore {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(baseUrl: string, fetchFn?: typeof fetch) {
    this.base = baseUrl.replace(/\/$/, '');
    this.fetchFn = fetchFn ?? ((...args) => globalThis.fetch(...args));
  }

  async hasBlob(digest: Digest): Promise<boolean> {
    const response = await this.fetchFn(`${this.base}/blobs/${digest}`, { method: 'HEAD' });
    return response.ok;
  }

  async getBlob(digest: Digest): Promise<Uint8Array> {
    const response = await this.fetchFn(`${this.base}/blobs/${digest}`);
    if (!response.ok) throw new Error(`remote blob ${digest}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await verifyDigest(bytes, digest, 'remote blob');
    return bytes;
  }

  /** Byte-offset resume (Phase 6.6): `Range: bytes=<start>-`. Servers that
   * ignore Range return 200-full; the caller gets the remainder either way.
   * The completed whole verifies against the digest in fetchBlobResumable. */
  async getBlobRange(digest: Digest, start: number): Promise<Uint8Array> {
    const response = await this.fetchFn(`${this.base}/blobs/${digest}`, {
      headers: start > 0 ? { Range: `bytes=${start}-` } : {},
    });
    if (!response.ok && response.status !== 206) throw new Error(`remote blob ${digest}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return response.status === 206 || start === 0 ? bytes : bytes.subarray(start);
  }

  async putBlob(bytes: Uint8Array, expected?: Digest): Promise<Digest> {
    const digest = expected ?? (await sha256(bytes));
    const response = await this.fetchFn(`${this.base}/blobs/${digest}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes as BodyInit,
    });
    if (!response.ok) throw new Error(`remote putBlob ${digest}: ${response.status} ${await response.text()}`);
    return digest;
  }

  async getRef(ref: string): Promise<StoredRef | null> {
    const response = await this.fetchFn(`${this.base}/refs?name=${encodeURIComponent(ref)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`remote getRef: ${response.status}`);
    return (await response.json()) as StoredRef;
  }

  async putRef(ref: string, manifestDigest: Digest, mediaType: string): Promise<void> {
    const response = await this.fetchFn(`${this.base}/refs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref, manifestDigest, mediaType }),
    });
    if (!response.ok) throw new Error(`remote putRef: ${response.status} ${await response.text()}`);
  }

  async listRefs(): Promise<StoredRef[]> {
    const response = await this.fetchFn(`${this.base}/refs`);
    if (!response.ok) throw new Error(`remote listRefs: ${response.status}`);
    return (await response.json()) as StoredRef[];
  }
}
