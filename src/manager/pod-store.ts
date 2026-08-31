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
import type { StoredRef } from '../oci/store.js';
import { OciStore } from '../oci/store.js';

export interface PodStore {
  hasBlob(digest: Digest): Promise<boolean>;
  /** Read + verify; tampered content throws. */
  getBlob(digest: Digest): Promise<Uint8Array>;
  putBlob(bytes: Uint8Array, expected?: Digest): Promise<Digest>;
  getRef(ref: string): Promise<StoredRef | null>;
  putRef(ref: string, manifestDigest: Digest, mediaType: string): Promise<void>;
  listRefs(): Promise<StoredRef[]>;
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
  constructor(
    private readonly fs: PodFs,
    private readonly dir: string,
  ) {}

  private blobPath(digest: Digest): string {
    return `${this.dir}/blobs/sha256/${digestHex(digest)}`;
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
    try {
      await this.fs.stat(this.blobPath(digest));
      return true;
    } catch {
      return false;
    }
  }

  async getBlob(digest: Digest): Promise<Uint8Array> {
    const raw = await this.fs.readFile(this.blobPath(digest));
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    await verifyDigest(bytes, digest);
    return bytes;
  }

  async putBlob(bytes: Uint8Array, expected?: Digest): Promise<Digest> {
    if (expected) await verifyDigest(bytes, expected);
    const digest = expected ?? (await sha256(bytes));
    if (!(await this.hasBlob(digest))) {
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
}
