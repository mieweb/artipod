/**
 * pullImage (issue #1 step 5): resolve → verify → store. Every byte is
 * digest-verified before it lands (tamper ⇒ throw), originals stay
 * compressed + immutable, each layer gains an uncompressed twin (verified
 * against the config's diff_ids) and a published LayerEntry[] index.
 */

import { gunzip, isGzip } from './gzip.js';
import { indexTar, type LayerEntry } from './tar.js';
import { sha256, verifyDigest, isDigest, type Digest } from './digest.js';
import type { OciStore } from './store.js';
import { parseImageRef, formatImageRef, type ImageRef, type OciTransport } from './transport.js';

interface OciDescriptor {
  mediaType: string;
  digest: Digest;
  size: number;
  platform?: { os: string; architecture: string; variant?: string };
}

export interface ImageManifest {
  schemaVersion: number;
  mediaType?: string;
  config: OciDescriptor;
  layers: OciDescriptor[];
}

const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);

export interface PulledLayer {
  digest: Digest;
  diffId: Digest;
  size: number;
  entryCount: number;
}

export interface PullResult {
  ref: string;
  manifestDigest: Digest;
  configDigest: Digest;
  layers: PulledLayer[];
}

export interface PullOptions {
  store: OciStore;
  transport: OciTransport;
  ref: string | ImageRef;
  /** Multi-arch selection; content is never executed, so any arch reads fine. */
  platform?: { os: string; architecture: string };
  onProgress?: (message: string) => void;
}

export async function pullImage(options: PullOptions): Promise<PullResult> {
  const { store, transport, onProgress } = options;
  const ref = typeof options.ref === 'string' ? parseImageRef(options.ref) : options.ref;
  const platform = options.platform ?? { os: 'linux', architecture: 'amd64' };
  const decoder = new TextDecoder();

  onProgress?.(`resolving ${formatImageRef(ref)}`);
  let resolved = await transport.resolve(ref);
  await store.putBlob(resolved.bytes, resolved.manifestDigest);

  let manifest = JSON.parse(decoder.decode(resolved.bytes)) as ImageManifest & {
    manifests?: OciDescriptor[];
  };

  if (INDEX_TYPES.has(resolved.mediaType) || Array.isArray(manifest.manifests)) {
    const candidates = manifest.manifests ?? [];
    const match =
      candidates.find((m) => m.platform?.os === platform.os && m.platform.architecture === platform.architecture) ??
      candidates.find((m) => m.platform?.os === platform.os) ??
      candidates[0];
    if (!match) throw new Error(`No platform manifest in index for ${formatImageRef(ref)}`);
    onProgress?.(`selected ${match.platform?.os ?? '?'}/${match.platform?.architecture ?? '?'} manifest`);
    resolved = await transport.resolve(ref, { digest: match.digest });
    await verifyDigest(resolved.bytes, match.digest, 'platform manifest');
    await store.putBlob(resolved.bytes, match.digest);
    manifest = JSON.parse(decoder.decode(resolved.bytes)) as ImageManifest;
  }

  if (!manifest.config || !Array.isArray(manifest.layers)) {
    throw new Error(`Unsupported manifest shape for ${formatImageRef(ref)} (${resolved.mediaType})`);
  }

  onProgress?.('fetching config');
  const configBytes = await transport.fetchBlob(ref, manifest.config.digest);
  await store.putBlob(configBytes, manifest.config.digest); // putBlob verifies
  const config = JSON.parse(decoder.decode(configBytes)) as { rootfs?: { diff_ids?: string[] } };
  const diffIds = config.rootfs?.diff_ids ?? [];

  const layers: PulledLayer[] = [];
  for (const [i, layer] of manifest.layers.entries()) {
    const knownDiffId = diffIds[i] && isDigest(diffIds[i]) ? (diffIds[i] as Digest) : undefined;
    // Anti-entropy skip: digest-addressed content already here never re-fetches.
    if (knownDiffId && (await store.hasBlob(layer.digest)) && (await store.hasUncompressed(knownDiffId))) {
      const entryCount = (await store.getLayerIndex(knownDiffId)).entries.length;
      layers.push({ digest: layer.digest, diffId: knownDiffId, size: layer.size, entryCount });
      onProgress?.(`layer ${i + 1}/${manifest.layers.length}: already present, skipped`);
      continue;
    }
    onProgress?.(`layer ${i + 1}/${manifest.layers.length}: ${layer.digest.slice(0, 19)}… (${layer.size} bytes)`);
    const compressed = await transport.fetchBlob(ref, layer.digest);
    await store.putBlob(compressed, layer.digest); // verifies vs descriptor digest — the tamper gate

    const uncompressed = isGzip(compressed) ? await gunzip(compressed) : compressed;
    const diffId = await sha256(uncompressed);
    const expected = diffIds[i];
    if (expected && isDigest(expected) && expected !== diffId) {
      throw new Error(`Layer ${i} diff ID mismatch: config says ${expected}, content is ${diffId}`);
    }
    await store.putUncompressed(diffId, uncompressed);

    const entries: LayerEntry[] = indexTar(uncompressed);
    await store.putLayerIndex(diffId, entries);
    layers.push({ digest: layer.digest, diffId, size: layer.size, entryCount: entries.length });
  }

  const displayRef = formatImageRef(ref);
  const manifestDigest = (await sha256(resolved.bytes)) as Digest;
  await store.putRef(displayRef, manifestDigest, resolved.mediaType);
  onProgress?.(`pulled ${displayRef} (${layers.length} layers)`);
  return { ref: displayRef, manifestDigest, configDigest: manifest.config.digest, layers };
}

/** Load the pulled image's layer indexes + uncompressed bytes for mounting. */
export async function loadImageLayers(
  store: OciStore,
  manifestDigest: Digest,
): Promise<{ diffIds: Digest[]; layers: LayerEntry[][]; layerBytes: Uint8Array[] }> {
  const decoder = new TextDecoder();
  const manifest = JSON.parse(decoder.decode(await store.getBlob(manifestDigest))) as ImageManifest;
  const config = JSON.parse(decoder.decode(await store.getBlob(manifest.config.digest))) as {
    rootfs?: { diff_ids?: Digest[] };
  };
  const diffIds = config.rootfs?.diff_ids ?? [];
  const layers: LayerEntry[][] = [];
  const layerBytes: Uint8Array[] = [];
  for (const diffId of diffIds) {
    layers.push((await store.getLayerIndex(diffId)).entries);
    layerBytes.push(await store.getUncompressed(diffId));
  }
  return { diffIds, layers, layerBytes };
}
