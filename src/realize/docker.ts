/**
 * realizeDocker — map a PodManifest onto docker bind mounts (plan Phase 3).
 *
 * Node + real directories only. Virtual sources cannot bind-mount into a
 * container (plan collision #4): that's use case 3 — sync the pod to a
 * server first, then execute with the docker backend. Fails fast with
 * actionable errors instead of guessing.
 *
 * Pure string mapping — no dockerode import, safe from any entry.
 */

import { validateManifest, type PodManifest } from '../manifest.js';

export interface DockerMountRealization {
  name: string;
  /** Container path (the manifest's app-chosen `path`). */
  path: string;
  hostDir: string;
  readonly: boolean;
}

export interface DockerRealization {
  /** dockerode Binds strings: host:container[:ro]. */
  binds: string[];
  mounts: DockerMountRealization[];
}

export function realizeDocker(manifest: PodManifest): DockerRealization {
  const m = validateManifest(manifest);
  if (m.root) {
    throw new Error(
      'realizeDocker: manifest.root (OCI image roots) is not realizable until the OCI store lands (Phase 4); ' +
        'use the container image configured via startContainer instead',
    );
  }
  const mounts = m.mounts.map((mount): DockerMountRealization => {
    if (mount.source.kind !== 'hostDir') {
      throw new Error(
        `realizeDocker: mount '${mount.name}' has a virtual source (${mount.source.kind}); ` +
          'docker can only bind real host directories — sync the pod to this host first, ' +
          'or run it in the ZenFS realizer (realizeZenFs)',
      );
    }
    if (mount.mode === 'cow') {
      throw new Error(
        `realizeDocker: mount '${mount.name}' wants copy-on-write; docker gets CoW with the OCI layer store (Phases 4–5) — use ro or rw for now`,
      );
    }
    return {
      name: mount.name,
      path: mount.path,
      hostDir: mount.source.dir,
      readonly: mount.mode === 'ro',
    };
  });
  return {
    mounts,
    binds: mounts.map((b) => `${b.hostDir}:${b.path}${b.readonly ? ':ro' : ''}`),
  };
}
