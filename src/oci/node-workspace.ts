/** Native semantics for a single Node hostDir pod's snapshot filesystem. */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { ZenFsLike } from '../sandbox/types.js';
import type { SnapshotFilesystem } from './snapshot.js';

/** ZenFS Passthrough emulates symlinks; snapshot native links as native links. */
export function createNativeWorkspaceFs(directory: string): ZenFsLike & SnapshotFilesystem {
  const resolve = (name: string) => {
    if (!name.startsWith('/') || name.includes('\0') || name.split('/').includes('..')) throw new Error(`Invalid pod path: ${name}`);
    return path.join(directory, name);
  };
  const methods = ['readdir', 'lstat', 'stat', 'readFile', 'writeFile', 'mkdir', 'rmdir', 'unlink', 'chmod'] as const;
  const promises: Record<string, unknown> = {};
  for (const method of methods) promises[method] = (name: string, ...args: unknown[]) => (fs[method] as (...a: unknown[]) => unknown)(resolve(name), ...args);
  promises.readlink = (name: string) => fs.readlink(resolve(name));
  promises.symlink = (target: string, name: string) => fs.symlink(target, resolve(name));
  const validateSnapshotPaths = async (paths: readonly string[]) => {
    const siblings = new Map<string, string[]>();
    // Compare user names with reserved roots too, even when those roots are
    // absent from the snapshot. Exact sentinel spellings are deduplicated.
    for (const name of new Set(['/.artipod', '/proc', ...paths])) {
      resolve(name); // apply the same pod-path validation as ordinary operations
      if (name === '/') continue;
      const parent = name.slice(0, name.lastIndexOf('/')) || '/';
      const group = siblings.get(parent) ?? [];
      group.push(name.slice(name.lastIndexOf('/') + 1));
      siblings.set(parent, group);
    }
    // Probe names on the actual filesystem: lowercasing alone misses Unicode
    // normalization and other volume-specific equivalences. Only empty private
    // directories are created; snapshot links and bytes never enter this tree.
    const groups = [...siblings].filter(([, names]) => names.length > 1);
    if (!groups.length) return;
    const probe = await fs.mkdtemp(path.join(directory, '.artipod', 'path-preflight-'));
    try {
      for (const [i, [parent, names]] of groups.entries()) {
        const group = path.join(probe, String(i));
        await fs.mkdir(group);
        for (const name of names) {
          try { await fs.mkdir(path.join(group, name)); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Invalid Artipod snapshot filesystem-equivalent paths in ${parent}: ${name}`, { cause: error });
            throw error;
          }
        }
      }
    } finally {
      await fs.rm(probe, { recursive: true });
    }
  };
  return { promises, validateSnapshotPaths } as unknown as ZenFsLike & SnapshotFilesystem;
}
