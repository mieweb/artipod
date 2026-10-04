/**
 * Manifest validation + docker realizer contract (pure — no docker daemon).
 * The live docker run over a manifest is in __tests__/manifestDocker.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_FORMAT_VERSION,
  parseManifest,
  serializeManifest,
  validateManifest,
  type PodManifest,
} from '../manifest.js';
import { realizeDocker } from './docker.js';

const hostMount = (over: Partial<PodManifest['mounts'][number]> = {}) => ({
  name: 'src',
  path: '/context/src',
  source: { kind: 'hostDir' as const, dir: '/tmp/src' },
  mode: 'ro' as const,
  ...over,
});

describe('validateManifest', () => {
  it('normalizes paths and stamps the format version', () => {
    const m = validateManifest({ mounts: [hostMount({ path: '/context//src/.' })] });
    expect(m.formatVersion).toBe(MANIFEST_FORMAT_VERSION);
    expect(m.mounts[0].path).toBe('/context/src');
  });

  it('rejects relative paths, duplicate names and duplicate paths', () => {
    expect(() => validateManifest({ mounts: [hostMount({ path: 'src' })] })).toThrow(/absolute/);
    expect(() =>
      validateManifest({ mounts: [hostMount(), hostMount({ path: '/other' })] }),
    ).toThrow(/Duplicate mount name/);
    expect(() =>
      validateManifest({ mounts: [hostMount(), hostMount({ name: 'two' })] }),
    ).toThrow(/Duplicate mount path/);
  });

  it('rejects unknown versions, modes, kinds and empty manifests', () => {
    expect(() => validateManifest({ formatVersion: 2 as never, mounts: [hostMount()] })).toThrow(
      /formatVersion/,
    );
    expect(() => validateManifest({ mounts: [hostMount({ mode: 'rwx' as never })] })).toThrow(
      /mode/,
    );
    expect(() =>
      validateManifest({ mounts: [hostMount({ source: { kind: 'nope' } as never })] }),
    ).toThrow(/source\.kind/);
    expect(() => validateManifest({ mounts: [] })).toThrow(/at least one mount/);
  });

  it('serialize/parse round-trips', () => {
    const m: PodManifest = { mounts: [hostMount()] };
    const parsed = parseManifest(serializeManifest(m));
    expect(parsed.mounts).toEqual(validateManifest(m).mounts);
  });
});

describe('realizeDocker', () => {
  it('binds hostDir mounts at their manifest paths with :ro for readonly', () => {
    const r = realizeDocker({
      mounts: [
        hostMount(),
        hostMount({ name: 'data', path: '/patients/12345', mode: 'rw', source: { kind: 'hostDir', dir: '/tmp/data' } }),
      ],
    });
    expect(r.binds).toEqual(['/tmp/src:/context/src:ro', '/tmp/data:/patients/12345']);
  });

  it('fails fast on virtual sources with an actionable error (collision #4)', () => {
    expect(() =>
      realizeDocker({
        mounts: [hostMount({ source: { kind: 'backend', backend: 'indexeddb' } })],
      }),
    ).toThrow(/virtual source.*sync the pod|sync the pod/s);
    expect(() =>
      realizeDocker({ mounts: [hostMount({ source: { kind: 'volume', ref: 'org/thing:1' } })] }),
    ).toThrow(/virtual source/);
  });

  it('rejects cow mounts and root images until the OCI store lands', () => {
    expect(() => realizeDocker({ mounts: [hostMount({ mode: 'cow' })] })).toThrow(/Phases 4/);
    expect(() =>
      realizeDocker({ root: { image: 'alpine:3.22' }, mounts: [hostMount()] }),
    ).toThrow(/Phase 4/);
  });
});
