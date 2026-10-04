/** Native semantics for a single Node hostDir pod's snapshot filesystem. */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { ZenFsLike } from '../sandbox/types.js';

/** ZenFS Passthrough emulates symlinks; snapshot native links as native links. */
export function createNativeWorkspaceFs(directory: string): ZenFsLike {
  const resolve = (name: string) => {
    if (!name.startsWith('/') || name.includes('\0') || name.split('/').includes('..')) throw new Error(`Invalid pod path: ${name}`);
    return path.join(directory, name);
  };
  const methods = ['readdir', 'lstat', 'stat', 'readFile', 'writeFile', 'mkdir', 'rmdir', 'unlink', 'chmod'] as const;
  const promises: Record<string, unknown> = {};
  for (const method of methods) promises[method] = (name: string, ...args: unknown[]) => (fs[method] as (...a: unknown[]) => unknown)(resolve(name), ...args);
  promises.readlink = (name: string) => fs.readlink(resolve(name));
  promises.symlink = (target: string, name: string) => fs.symlink(target, resolve(name));
  return { promises } as unknown as ZenFsLike;
}
