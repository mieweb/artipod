/**
 * The pod's OCI blob store (issue #1 step 1): digest-addressed content under
 * `/.artipod/oci/` in the pod's own fs — originals immutable and verifiable,
 * every consumer (shell, tools, editor) can see the store because it IS
 * files. Layout:
 *
 *   /.artipod/superblock.json                    cleartext superblock
 *   /.artipod/oci/blobs/sha256/<hex>             originals (ciphertext when the pod is encrypted)
 *   /.artipod/oci/uncompressed/sha256/<hex>      decompress-once twins, addressed by diff ID
 *   /.artipod/oci/indexes/sha256/<hex>.json      published layer-index artifacts (by diff ID)
 *   /.artipod/oci/refs/<encoded>.json            name → manifest digest
 *   /.artipod/oci/snapshots/                     Phase 5
 *   /.artipod/oci/upper/                         Phase 5
 */

import type { ZenFsLike } from '../sandbox/types.js';
import { sha256, verifyDigest, isDigest, digestHex, type Digest } from './digest.js';
import { decryptBlob, encryptBlob, isEncryptedBlob } from './cipher.js';
import { PodLockedError } from '../manager/keyring.js';
import { makeLayerIndexArtifact, parseLayerIndexArtifact, type LayerEntry, type LayerIndexArtifact } from './tar.js';

export const OCI_ROOT = '/.artipod/oci';
export const SUPERBLOCK_PATH = '/.artipod/superblock.json';

export interface PodSuperblock {
  formatVersion: 1;
  /** Opaque pod id — no names or clinical metadata (docs/encryption.md). */
  podId: string;
  cipher: 'none' | 'aes-256-gcm-chunked';
  createdAt: string;
  updatedAt: string;
}

export interface StoredRef {
  ref: string;
  manifestDigest: Digest;
  mediaType: string;
  pulledAt: string;
}

const refFileName = (ref: string) => `${encodeURIComponent(ref)}.json`;

/** ZenFS/node readFile may hand back Buffers; normalize to plain views. */
const asBytes = (b: Uint8Array): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

function randomPodId(): string {
  const buf = new Uint8Array(8);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class OciStore {
  /** Key custody (Phase 6.5): a provider so the keyring owns the KEK — an
   * expired lease makes the provider throw and the pod is simply locked. */
  private keySource: (() => CryptoKey) | null = null;
  private superblock: PodSuperblock | null = null;

  constructor(private readonly zfs: ZenFsLike) {}

  /** The live KEK, or null when encryption is off. Throws when locked. */
  private get key(): CryptoKey | null {
    return this.keySource ? this.keySource() : null;
  }

  /** True when the pod is encrypted but no usable key is available. */
  get locked(): boolean {
    if (!this.keySource) return false;
    try {
      this.keySource();
      return false;
    } catch {
      return true;
    }
  }

  /** True when this store writes ciphertext (regardless of lock state). */
  get encrypted(): boolean {
    return this.keySource !== null;
  }

  /** The live session KEK (non-extractable). Throws PodLockedError when locked. */
  get sessionKey(): CryptoKey {
    if (!this.keySource) throw new Error('this pod is not encrypted');
    return this.keySource();
  }

  private get p() {
    return this.zfs.promises;
  }

  async init(): Promise<PodSuperblock> {
    for (const dir of ['blobs/sha256', 'uncompressed/sha256', 'indexes/sha256', 'refs', 'snapshots', 'upper']) {
      await this.p.mkdir(`${OCI_ROOT}/${dir}`, { recursive: true });
    }
    try {
      this.superblock = JSON.parse((await this.p.readFile(SUPERBLOCK_PATH, 'utf8')) as string) as PodSuperblock;
    } catch {
      this.superblock = {
        formatVersion: 1,
        podId: randomPodId(),
        cipher: 'none',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.writeSuperblock();
    }
    return this.superblock;
  }

  private async writeSuperblock(): Promise<void> {
    if (!this.superblock) throw new Error('store not initialized');
    this.superblock.updatedAt = new Date().toISOString();
    await this.p.writeFile(SUPERBLOCK_PATH, JSON.stringify(this.superblock, null, 2));
  }

  getSuperblock(): PodSuperblock {
    if (!this.superblock) throw new Error('store not initialized — call init()');
    return this.superblock;
  }

  /**
   * Per-pod encryption opt-in: subsequent blob writes are stored as
   * chunked-AEAD ciphertext addressed by ciphertext digest, with the
   * plaintext digest resolvable via the alias map. Pass a provider to put
   * the keyring in custody — key evaporation IS the lock.
   */
  async enableEncryption(key: CryptoKey | (() => CryptoKey)): Promise<void> {
    this.keySource = typeof key === 'function' ? key : () => key;
    this.getSuperblock().cipher = 'aes-256-gcm-chunked';
    await this.writeSuperblock();
  }

  private blobPath(digest: Digest): string {
    return `${OCI_ROOT}/blobs/sha256/${digestHex(digest)}`;
  }

  /** plaintext digest → ciphertext digest aliases (encrypted pods). */
  private aliasPath(digest: Digest): string {
    return `${OCI_ROOT}/blobs/sha256/${digestHex(digest)}.alias`;
  }

  /**
   * Store a blob (immutable: content-addressed writes are idempotent).
   * Verifies against `expected` when given; returns the PLAINTEXT digest —
   * the store's addressing never changes when encryption is on.
   */
  async putBlob(bytes: Uint8Array, expected?: Digest): Promise<Digest> {
    if (expected) await verifyDigest(bytes, expected);
    const digest = expected ?? (await sha256(bytes));
    if (!this.key) {
      if (!(await this.hasBlob(digest))) await this.p.writeFile(this.blobPath(digest), bytes);
      return digest;
    }
    if (await this.hasBlob(digest)) return digest;
    const encrypted = await encryptBlob(bytes, this.key);
    await this.p.writeFile(this.blobPath(encrypted.ciphertextDigest), encrypted.bytes);
    await this.p.writeFile(this.aliasPath(digest), encrypted.ciphertextDigest);
    return digest;
  }

  async hasBlob(digest: Digest): Promise<boolean> {
    for (const path of [this.blobPath(digest), this.aliasPath(digest)]) {
      try {
        await this.p.stat(path);
        return true;
      } catch {
        // keep looking
      }
    }
    return false;
  }

  /** Read + verify a blob by digest; tampered content throws. */
  async getBlob(digest: Digest): Promise<Uint8Array> {
    if (!isDigest(digest)) throw new Error(`Not a digest: '${digest}'`);
    let raw: Uint8Array;
    try {
      raw = asBytes((await this.p.readFile(this.blobPath(digest))) as Uint8Array);
    } catch {
      const cipherDigest = (await this.p.readFile(this.aliasPath(digest), 'utf8')) as Digest;
      raw = asBytes((await this.p.readFile(this.blobPath(cipherDigest))) as Uint8Array);
      await verifyDigest(raw, cipherDigest, 'ciphertext blob');
      if (!this.keySource) throw new PodLockedError(`blob ${digest} is encrypted and this session holds no key`);
      return decryptBlob(raw, this.keySource(), digest);
    }
    if (isEncryptedBlob(raw) && this.keySource) {
      // Addressed directly by ciphertext digest.
      await verifyDigest(raw, digest, 'ciphertext blob');
      return decryptBlob(raw, this.keySource());
    }
    await verifyDigest(raw, digest);
    return raw;
  }

  /** Stored bytes exactly as they sit on disk (ciphertext for encrypted
   * pods) — what relays and encrypted sync move. Never decrypts. */
  async getRawBlob(digest: Digest): Promise<Uint8Array> {
    const raw = asBytes((await this.p.readFile(this.blobPath(digest))) as Uint8Array);
    await verifyDigest(raw, digest, 'raw blob');
    return raw;
  }

  /** plaintext digest → ciphertext digest, or null when stored plain. */
  async resolveAlias(digest: Digest): Promise<Digest | null> {
    try {
      return (await this.p.readFile(this.aliasPath(digest), 'utf8')) as Digest;
    } catch {
      return null;
    }
  }

  async deleteBlob(digest: Digest): Promise<void> {
    await this.p.rm(this.blobPath(digest), { force: true });
    await this.p.rm(this.aliasPath(digest), { force: true });
  }

  /** Kiosk (`purge`) lock mode: drop every blob; ciphertext restore = re-sync. */
  async purgeBlobs(): Promise<number> {
    const dir = `${OCI_ROOT}/blobs/sha256`;
    const names = (await this.p.readdir(dir)) as string[];
    for (const name of names) await this.p.rm(`${dir}/${name}`, { force: true });
    return names.length;
  }

  // --- decompress-once twins (addressed by diff ID) --------------------------

  async putUncompressed(diffId: Digest, bytes: Uint8Array): Promise<void> {
    await verifyDigest(bytes, diffId, 'uncompressed layer');
    // Twins hold the same content as layers — ciphertext at rest too
    // (docs/encryption.md: layer-only encryption is theater).
    const out = this.key ? (await encryptBlob(bytes, this.key)).bytes : bytes;
    await this.p.writeFile(`${OCI_ROOT}/uncompressed/sha256/${digestHex(diffId)}`, out);
  }

  async getUncompressed(diffId: Digest): Promise<Uint8Array> {
    const bytes = asBytes(
      (await this.p.readFile(`${OCI_ROOT}/uncompressed/sha256/${digestHex(diffId)}`)) as Uint8Array,
    );
    if (isEncryptedBlob(bytes)) {
      if (!this.keySource) throw new PodLockedError(`layer ${diffId} is encrypted and this session holds no key`);
      return decryptBlob(bytes, this.keySource(), diffId);
    }
    await verifyDigest(bytes, diffId, 'uncompressed layer');
    return bytes;
  }

  async hasUncompressed(diffId: Digest): Promise<boolean> {
    try {
      await this.p.stat(`${OCI_ROOT}/uncompressed/sha256/${digestHex(diffId)}`);
      return true;
    } catch {
      return false;
    }
  }

  // --- published layer indexes ------------------------------------------------

  async putLayerIndex(diffId: Digest, entries: LayerEntry[]): Promise<void> {
    const artifact = makeLayerIndexArtifact(entries);
    await this.p.writeFile(`${OCI_ROOT}/indexes/sha256/${digestHex(diffId)}.json`, JSON.stringify(artifact));
  }

  async getLayerIndex(diffId: Digest): Promise<LayerIndexArtifact> {
    return parseLayerIndexArtifact(
      (await this.p.readFile(`${OCI_ROOT}/indexes/sha256/${digestHex(diffId)}.json`, 'utf8')) as string,
    );
  }

  // --- refs --------------------------------------------------------------------

  async putRef(ref: string, manifestDigest: Digest, mediaType: string): Promise<void> {
    const stored: StoredRef = { ref, manifestDigest, mediaType, pulledAt: new Date().toISOString() };
    await this.p.writeFile(`${OCI_ROOT}/refs/${refFileName(ref)}`, JSON.stringify(stored, null, 2));
  }

  async getRef(ref: string): Promise<StoredRef | null> {
    try {
      return JSON.parse((await this.p.readFile(`${OCI_ROOT}/refs/${refFileName(ref)}`, 'utf8')) as string) as StoredRef;
    } catch {
      return null;
    }
  }

  async listRefs(): Promise<StoredRef[]> {
    let names: string[];
    try {
      names = (await this.p.readdir(`${OCI_ROOT}/refs`)) as string[];
    } catch {
      return [];
    }
    const refs: StoredRef[] = [];
    for (const name of names.sort()) {
      try {
        refs.push(JSON.parse((await this.p.readFile(`${OCI_ROOT}/refs/${name}`, 'utf8')) as string) as StoredRef);
      } catch {
        // skip corrupt entries
      }
    }
    return refs;
  }
}
