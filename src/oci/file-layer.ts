/**
 * Per-file (and whiteout) layer construction shared by the server's folder
 * publisher and the browser's overlay push (sync plan Phases C/E). One
 * bucket of tar entries → one gzipped layer blob + its published index
 * artifact + an annotated OCI descriptor. Isomorphic: WebCrypto digests,
 * CompressionStream gzip, pure tar.
 */

import { sha256, type Digest } from './digest.js';
import { gzip } from './gzip.js';
import {
  ANNOTATION_HYDRATION,
  ANNOTATION_LAYER_GROUP,
  ANNOTATION_LAYER_INDEX,
  indexTar,
  makeLayerIndexArtifact,
  writeTar,
  type LayerEntry,
  type TarWriteEntry,
} from './tar.js';

export const ANNOTATION_PATH = 'org.artipod.path';
export const ANNOTATION_MTIME = 'org.artipod.mtime';
export const ANNOTATION_ACTOR = 'org.artipod.actor';
export const ANNOTATION_PARENTS = 'org.artipod.parents';
/** Marks layers appended by an overlay push — replaced wholesale on the next push by the same actor. */
export const ANNOTATION_OVERLAY = 'org.artipod.overlay';

const encoder = new TextEncoder();

export interface FileLayerMeta {
  /** Representative path (the file, the group glob, or '.wh' for a whiteout layer). */
  path: string;
  /** The LWW clock (Decision D8). */
  mtimeMs: number;
  actor: string;
  group?: string;
  /** Set on overlay-push layers (the pushing actor). */
  overlay?: string;
}

export interface BuiltFileLayer {
  tar: Uint8Array;
  diffId: Digest;
  compressed: Uint8Array;
  layerDigest: Digest;
  indexEntries: LayerEntry[];
  indexBytes: Uint8Array;
  indexDigest: Digest;
  descriptor: {
    mediaType: string;
    digest: Digest;
    size: number;
    annotations: Record<string, string>;
  };
}

export async function buildFileLayer(entries: TarWriteEntry[], meta: FileLayerMeta): Promise<BuiltFileLayer> {
  const tar = writeTar(entries);
  const diffId = await sha256(tar);
  const compressed = await gzip(tar);
  const layerDigest = await sha256(compressed);
  const indexEntries = indexTar(tar);
  const indexBytes = encoder.encode(JSON.stringify(makeLayerIndexArtifact(indexEntries)));
  const indexDigest = await sha256(indexBytes);
  return {
    tar,
    diffId,
    compressed,
    layerDigest,
    indexEntries,
    indexBytes,
    indexDigest,
    descriptor: {
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: layerDigest,
      size: compressed.length,
      annotations: {
        [ANNOTATION_HYDRATION]: 'lazy',
        [ANNOTATION_LAYER_INDEX]: indexDigest,
        [ANNOTATION_PATH]: meta.path,
        [ANNOTATION_MTIME]: String(Math.round(meta.mtimeMs)),
        [ANNOTATION_ACTOR]: meta.actor,
        ...(meta.group ? { [ANNOTATION_LAYER_GROUP]: meta.group } : {}),
        ...(meta.overlay ? { [ANNOTATION_OVERLAY]: meta.overlay } : {}),
      },
    },
  };
}
