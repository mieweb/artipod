/**
 * Encrypted sync through blind relays (docs/encryption.md: "Sync and relays
 * move ciphertext only"). The relay is an ordinary PodStore holding
 * ciphertext blobs it can never read; the ref points at an ENCRYPTED
 * envelope listing the plaintext→ciphertext digest pairs, so only key
 * holders can even enumerate the image. Every hop is digest-verified.
 */
import { sha256, isDigest, type Digest } from '../oci/digest.js';
import { decryptBlob, encryptBlob } from '../oci/cipher.js';
import { gunzip, isGzip } from '../oci/gzip.js';
import { indexTar } from '../oci/tar.js';
import type { ImageManifest } from '../oci/pull.js';
import type { OciStore } from '../oci/store.js';
import type { PodStore } from './pod-store.js';
import { walkImageDigests } from './sync.js';
import { canonicalJson } from './crypto.js';

export const ENCRYPTED_REF_MEDIA_TYPE = 'application/vnd.artipod.encrypted-ref.v1+json';

interface EncryptedEnvelope {
  formatVersion: 1;
  manifestDigest: Digest;
  mediaType: string;
  /** plaintext digest → ciphertext digest, for every blob the ref reaches. */
  entries: { plain: Digest; cipher: Digest }[];
}

export interface EncryptedSyncResult {
  ref: string;
  moved: number;
  skipped: number;
  movedBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Push an encrypted pod's ref to a relay: ciphertext blobs under their
 * ciphertext digests + one KEK-encrypted envelope. The relay learns sizes
 * and digests, nothing else.
 */
export async function pushEncryptedRef(src: OciStore, relay: PodStore, ref: string, key: CryptoKey): Promise<EncryptedSyncResult> {
  const stored = await src.getRef(ref);
  if (!stored) throw new Error(`ref '${ref}' not found in the source store`);
  let moved = 0;
  let skipped = 0;
  let movedBytes = 0;
  const entries: EncryptedEnvelope['entries'] = [];
  for (const plain of await walkImageDigests(src, stored.manifestDigest)) {
    const cipher = await src.resolveAlias(plain);
    if (!cipher) throw new Error(`blob ${plain} is not stored encrypted — refusing to relay plaintext`);
    entries.push({ plain, cipher });
    if (await relay.hasBlob(cipher)) {
      skipped++;
      continue;
    }
    const bytes = await src.getRawBlob(cipher);
    await relay.putBlob(bytes, cipher);
    moved++;
    movedBytes += bytes.length;
  }
  const envelope: EncryptedEnvelope = {
    formatVersion: 1,
    manifestDigest: stored.manifestDigest,
    mediaType: stored.mediaType,
    entries,
  };
  const sealed = await encryptBlob(encoder.encode(canonicalJson(envelope)), key);
  await relay.putBlob(sealed.bytes, sealed.ciphertextDigest);
  await relay.putRef(ref, sealed.ciphertextDigest, ENCRYPTED_REF_MEDIA_TYPE);
  return { ref, moved, skipped, movedBytes };
}

/**
 * Pull an encrypted ref from a relay into a key-holding store: the envelope
 * decrypts, each ciphertext blob verifies against its ciphertext digest,
 * decrypts, and the plaintext verifies against its plaintext digest —
 * end-to-end integrity with zero trust in the relay.
 */
export async function pullEncryptedRef(relay: PodStore, dst: OciStore, ref: string, key: CryptoKey): Promise<EncryptedSyncResult> {
  const stored = await relay.getRef(ref);
  if (!stored) throw new Error(`ref '${ref}' not found on the relay`);
  if (stored.mediaType !== ENCRYPTED_REF_MEDIA_TYPE) throw new Error(`ref '${ref}' is not an encrypted ref`);
  const sealedBytes = await relay.getBlob(stored.manifestDigest);
  if ((await sha256(sealedBytes)) !== stored.manifestDigest) throw new Error('relay envelope is corrupt');
  const envelope = JSON.parse(decoder.decode(await decryptBlob(sealedBytes, key))) as EncryptedEnvelope;
  let moved = 0;
  let skipped = 0;
  let movedBytes = 0;
  for (const { plain, cipher } of envelope.entries) {
    if (await dst.hasBlob(plain)) {
      skipped++;
      continue;
    }
    const cipherBytes = await relay.getBlob(cipher); // relay-side digest check
    if ((await sha256(cipherBytes)) !== cipher) throw new Error(`relay tampered with blob ${cipher}`);
    const plainBytes = await decryptBlob(cipherBytes, key, plain); // verifies plaintext digest
    await dst.putBlob(plainBytes, plain); // re-encrypts under the local store's key custody
    moved++;
    movedBytes += cipherBytes.length;
  }
  await dst.putRef(ref, envelope.manifestDigest, envelope.mediaType);
  await indexPulledImage(dst, envelope.manifestDigest);
  return { ref, moved, skipped, movedBytes };
}

/** Post-pull twin/index build — what pullImage does inline — so the pulled
 * image mounts and clones like any other. */
async function indexPulledImage(store: OciStore, manifestDigest: Digest): Promise<void> {
  const manifest = JSON.parse(decoder.decode(await store.getBlob(manifestDigest))) as ImageManifest;
  if (!manifest.config || !Array.isArray(manifest.layers)) return;
  const config = JSON.parse(decoder.decode(await store.getBlob(manifest.config.digest))) as {
    rootfs?: { diff_ids?: string[] };
    diff_ids?: string[];
  };
  const diffIds = config.rootfs?.diff_ids ?? config.diff_ids ?? [];
  for (const [i, layer] of manifest.layers.entries()) {
    const bytes = await store.getBlob(layer.digest);
    const uncompressed = isGzip(bytes) ? await gunzip(bytes) : bytes;
    const diffId = await sha256(uncompressed);
    const expected = diffIds[i];
    if (expected && isDigest(expected) && expected !== diffId) {
      throw new Error(`layer ${i} diff ID mismatch after decrypt: config says ${expected}, content is ${diffId}`);
    }
    if (!(await store.hasUncompressed(diffId))) {
      await store.putUncompressed(diffId, uncompressed);
      await store.putLayerIndex(diffId, indexTar(uncompressed));
    }
  }
}
