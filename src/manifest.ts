/**
 * PodManifest — the declarative mount table of a pod (plan Phase 3, aligned
 * with issue #1's "Artipod mount declaration").
 *
 * Core enforces NO path prefix scheme (Decision #3): every mount declares an
 * explicit absolute `path`; `/context/<name>` survives only as our apps'
 * suggested template. Realizers interpret `source`:
 *   - realizeZenFs (browser + Node): backend/hostDir/cow
 *   - realizeDocker (Node, real dirs): hostDir only — virtual sources fail
 *     fast (plan collision #4)
 *   - volume sources become real with the OCI store (Phase 4)
 */

import { normalizePosix } from './pathUtils.js';

export const MANIFEST_FORMAT_VERSION = 1 as const;
/** Media type for manifests at rest (issue #1: vnd.artipod.* from day one). */
export const MANIFEST_MEDIA_TYPE = 'application/vnd.artipod.manifest.v1+json';

export type MountMode = 'ro' | 'cow' | 'rw';

export type MountSource =
  | { kind: 'hostDir'; dir: string }
  | { kind: 'backend'; backend: 'indexeddb' | 'opfs' | 'memory' }
  | { kind: 'volume'; ref: string };

export interface PodMountDeclaration {
  /** ArtiMount name. */
  name: string;
  /** App/harness-chosen absolute pod path (Decision #3). */
  path: string;
  source: MountSource;
  mode: MountMode;
}

export interface PodManifest {
  /** Versioned from day one (plan §5 schema-regret mitigation). */
  formatVersion?: typeof MANIFEST_FORMAT_VERSION;
  /** OCI image ref for the root filesystem — realized from Phase 4 on. */
  root?: { image: string };
  mounts: PodMountDeclaration[];
}

const MODES: ReadonlySet<string> = new Set(['ro', 'cow', 'rw']);
const SOURCE_KINDS: ReadonlySet<string> = new Set(['hostDir', 'backend', 'volume']);
const BACKENDS: ReadonlySet<string> = new Set(['indexeddb', 'opfs', 'memory']);

/**
 * Validate a manifest and return it with normalized mount paths.
 * Throws with actionable messages — realizers call this first.
 */
export function validateManifest(manifest: PodManifest): PodManifest {
  if (!manifest || !Array.isArray(manifest.mounts)) {
    throw new Error('Pod manifest must have a mounts array');
  }
  if (manifest.formatVersion !== undefined && manifest.formatVersion !== MANIFEST_FORMAT_VERSION) {
    throw new Error(
      `Unsupported manifest formatVersion ${String(manifest.formatVersion)} (this build understands ${MANIFEST_FORMAT_VERSION})`,
    );
  }
  if (manifest.root && !manifest.root.image) {
    throw new Error('manifest.root requires an image reference');
  }
  if (manifest.mounts.length === 0 && !manifest.root) {
    throw new Error('Pod manifest needs at least one mount (or a root image)');
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  const mounts = manifest.mounts.map((m) => {
    if (!m.name || m.name.includes('/')) {
      throw new Error(`Mount name must be a non-empty single segment: '${String(m.name)}'`);
    }
    if (names.has(m.name)) throw new Error(`Duplicate mount name: '${m.name}'`);
    names.add(m.name);
    if (typeof m.path !== 'string' || !m.path.startsWith('/')) {
      throw new Error(`Mount '${m.name}': path must be absolute (got '${String(m.path)}')`);
    }
    const path = m.path === '/' ? '/' : normalizePosix(m.path);
    if (paths.has(path)) throw new Error(`Duplicate mount path: '${path}'`);
    paths.add(path);
    if (!MODES.has(m.mode)) {
      throw new Error(`Mount '${m.name}': mode must be ro|cow|rw (got '${String(m.mode)}')`);
    }
    if (!m.source || !SOURCE_KINDS.has(m.source.kind)) {
      throw new Error(`Mount '${m.name}': source.kind must be hostDir|backend|volume`);
    }
    if (m.source.kind === 'hostDir' && !m.source.dir) {
      throw new Error(`Mount '${m.name}': hostDir source requires 'dir'`);
    }
    if (m.source.kind === 'backend' && !BACKENDS.has(m.source.backend)) {
      throw new Error(`Mount '${m.name}': backend must be indexeddb|opfs|memory`);
    }
    if (m.source.kind === 'volume' && !m.source.ref) {
      throw new Error(`Mount '${m.name}': volume source requires 'ref'`);
    }
    return { ...m, path };
  });
  return { ...manifest, formatVersion: MANIFEST_FORMAT_VERSION, mounts };
}

/** Stable JSON for /proc/pod/manifest.json and storage at rest. */
export function serializeManifest(manifest: PodManifest): string {
  const m = validateManifest(manifest);
  return JSON.stringify({ formatVersion: MANIFEST_FORMAT_VERSION, ...m }, null, 2) + '\n';
}

export function parseManifest(json: string): PodManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`Pod manifest is not valid JSON: ${(e as Error).message}`);
  }
  return validateManifest(raw as PodManifest);
}
