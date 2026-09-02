/**
 * PodStore — what a pod manager persists pods into (plan Phase 6,
 * Decision #6: the manager decides durability). The sync surface is the
 * minimal digest-addressed set: blobs + refs; uncompressed twins and layer
 * indexes are derived locally after transfer.
 *
 * Shipped implementations:
 *  - ZenFsPodStore   — the pod's own OciStore (browser + Node)
 *  - OciLayoutPodStore — a plain directory in OCI image-layout format
 *    (skopeo/crane-inspectable; the hosted manager's default), PodFs-injected
 *    so it runs over node:fs or ZenFS alike
 *  - HttpPodStore    — client for a manager's HTTP sync routes (http-store.ts)
 */

import type { PodFs } from '../podfs.js';
import { sha256, verifyDigest, digestHex, type Digest } from '../oci/digest.js';
import { decryptBlob, encryptBlob } from '../oci/cipher.js';
import type { StoredRef } from '../oci/store.js';
import { OciStore } from '../oci/store.js';
import { PodLockedError } from './keyring.js';

export interface PodStore {
  hasBlob(digest: Digest): Promise<boolean>;
  /** Read + verify; tampered content throws. */
  getBlob(digest: Digest): Promise<Uint8Array>;
  putBlob(bytes: Uint8Array, expected?: Digest): Promise<Digest>;
  getRef(ref: string): Promise<StoredRef | null>;
  putRef(ref: string, manifestDigest: Digest, mediaType: string): Promise<void>;
  listRefs(): Promise<StoredRef[]>;
  /** Remove a ref (the pointer only — blobs and history stay). False = no such ref. */
  deleteRef?(ref: string): Promise<boolean>;
}

/** The pod's own ZenFS-backed store IS a PodStore. */
export type ZenFsPodStore = OciStore;

interface LayoutManifestDescriptor {
  mediaType: string;
  digest: Digest;
  size: number;
  annotations?: Record<string, string>;
}

interface LayoutIndex {
  schemaVersion: 2;
  manifests: LayoutManifestDescriptor[];
}

const REF_ANNOTATION = 'org.opencontainers.image.ref.name';
const PULLED_AT_ANNOTATION = 'org.artipod.pulledAt';
const MEDIA_TYPE_ANNOTATION = 'org.artipod.refMediaType';

/**
 * OCI image-layout directory store: `oci-layout`, `index.json`, and
 * `blobs/sha256/<hex>` — trivially backed up, imported, and inspected with
 * standard tooling.
 */
export class OciLayoutPodStore implements PodStore {
  private keySource: (() => CryptoKey) | null = null;

  constructor(
    private readonly fs: PodFs,
    private readonly dir: string,
  ) {}

  private blobPath(digest: Digest): string {
    return `${this.dir}/blobs/sha256/${digestHex(digest)}`;
  }

  /** plaintext digest → ciphertext digest aliases (encrypted stores). */
  private aliasPath(digest: Digest): string {
    return `${this.blobPath(digest)}.alias`;
  }

  /**
   * At-rest encryption opt-in (serve `--encrypt`): subsequent putBlob writes
   * store chunked-AEAD ciphertext addressed by ciphertext digest, with the
   * plaintext digest resolvable via the alias map — the same scheme as
   * OciStore. Blobs already on disk stay as they are. Pass a provider to
   * put a keyring in custody; a keyless reopen serves ciphertext-addressed
   * blobs untouched (blind host) and refuses plaintext addressing.
   */
  enableEncryption(key: CryptoKey | (() => CryptoKey)): void {
    this.keySource = typeof key === 'function' ? key : () => key;
  }

  /** True when this store writes ciphertext (regardless of lock state). */
  get encrypted(): boolean {
    return this.keySource !== null;
  }

  async init(): Promise<void> {
    await this.fs.mkdir(`${this.dir}/blobs/sha256`, { recursive: true });
    try {
      await this.fs.stat(`${this.dir}/oci-layout`);
    } catch {
      await this.fs.writeFile(`${this.dir}/oci-layout`, JSON.stringify({ imageLayoutVersion: '1.0.0' }));
      await this.fs.writeFile(`${this.dir}/index.json`, JSON.stringify({ schemaVersion: 2, manifests: [] }));
    }
  }

  private async readIndex(): Promise<LayoutIndex> {
    try {
      return JSON.parse(await this.fs.readFile(`${this.dir}/index.json`, 'utf8')) as LayoutIndex;
    } catch {
      return { schemaVersion: 2, manifests: [] };
    }
  }

  async hasBlob(digest: Digest): Promise<boolean> {
    for (const path of [this.blobPath(digest), this.aliasPath(digest)]) {
      try {
        await this.fs.stat(path);
        return true;
      } catch {
        // keep looking
      }
    }
    return false;
  }

  /** True when the blob sits on disk as ciphertext (alias twin present) — key not required. */
  async isBlobEncrypted(digest: Digest): Promise<boolean> {
    try {
      await this.fs.stat(this.aliasPath(digest));
      return true;
    } catch {
      return false;
    }
  }

  async getBlob(digest: Digest): Promise<Uint8Array> {
    let raw: Uint8Array;
    try {
      const read = await this.fs.readFile(this.blobPath(digest));
      raw = new Uint8Array(read.buffer, read.byteOffset, read.byteLength);
    } catch {
      // Plaintext-addressed read of an encrypted blob: follow the alias.
      // (Ciphertext-addressed reads take the branch above and return the
      // stored bytes exactly — that is what blind sync moves.)
      const cipherDigest = (await this.fs.readFile(this.aliasPath(digest), 'utf8')) as Digest;
      const cipherRead = await this.fs.readFile(this.blobPath(cipherDigest));
      const cipherRaw = new Uint8Array(cipherRead.buffer, cipherRead.byteOffset, cipherRead.byteLength);
      await verifyDigest(cipherRaw, cipherDigest, 'ciphertext blob');
      if (!this.keySource) throw new PodLockedError(`blob ${digest} is encrypted and this store holds no key`);
      return decryptBlob(cipherRaw, this.keySource(), digest);
    }
    await verifyDigest(raw, digest);
    return raw;
  }

  async putBlob(bytes: Uint8Array, expected?: Digest): Promise<Digest> {
    if (expected) await verifyDigest(bytes, expected);
    const digest = expected ?? (await sha256(bytes));
    if (await this.hasBlob(digest)) return digest;
    if (this.keySource) {
      const encrypted = await encryptBlob(bytes, this.keySource());
      await this.fs.writeFile(this.blobPath(encrypted.ciphertextDigest), encrypted.bytes);
      await this.fs.writeFile(this.aliasPath(digest), encrypted.ciphertextDigest);
    } else {
      await this.fs.writeFile(this.blobPath(digest), bytes);
    }
    return digest;
  }

  async getRef(ref: string): Promise<StoredRef | null> {
    const index = await this.readIndex();
    const found = index.manifests.find((m) => m.annotations?.[REF_ANNOTATION] === ref);
    if (!found) return null;
    return {
      ref,
      manifestDigest: found.digest,
      mediaType: found.annotations?.[MEDIA_TYPE_ANNOTATION] ?? found.mediaType,
      pulledAt: found.annotations?.[PULLED_AT_ANNOTATION] ?? '',
    };
  }

  async putRef(ref: string, manifestDigest: Digest, mediaType: string): Promise<void> {
    const index = await this.readIndex();
    const size = (await this.getBlob(manifestDigest)).length;
    const descriptor: LayoutManifestDescriptor = {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: manifestDigest,
      size,
      annotations: {
        [REF_ANNOTATION]: ref,
        [MEDIA_TYPE_ANNOTATION]: mediaType,
        [PULLED_AT_ANNOTATION]: new Date().toISOString(),
      },
    };
    const manifests = index.manifests.filter((m) => m.annotations?.[REF_ANNOTATION] !== ref);
    manifests.push(descriptor);
    await this.fs.writeFile(`${this.dir}/index.json`, JSON.stringify({ schemaVersion: 2, manifests }, null, 2));
  }

  async listRefs(): Promise<StoredRef[]> {
    const index = await this.readIndex();
    return index.manifests
      .filter((m) => m.annotations?.[REF_ANNOTATION])
      .map((m) => ({
        ref: m.annotations![REF_ANNOTATION],
        manifestDigest: m.digest,
        mediaType: m.annotations?.[MEDIA_TYPE_ANNOTATION] ?? m.mediaType,
        pulledAt: m.annotations?.[PULLED_AT_ANNOTATION] ?? '',
      }));
  }

  async deleteRef(ref: string): Promise<boolean> {
    const index = await this.readIndex();
    const manifests = index.manifests.filter((m) => m.annotations?.[REF_ANNOTATION] !== ref);
    if (manifests.length === index.manifests.length) return false;
    await this.fs.writeFile(`${this.dir}/index.json`, JSON.stringify({ schemaVersion: 2, manifests }, null, 2));
    return true;
  }
}
