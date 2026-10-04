/**
 * nodePodFs — PodFs adapter over node:fs/promises.
 *
 * This file (and src/docker/) are the only places in the package allowed to
 * import node:fs. Everything else operates on an injected PodFs.
 */

import { promises as nfs } from 'node:fs';
import type { PodFs } from './podfs.js';

export function nodePodFs(): PodFs {
  return {
    readFile: ((path: string, encoding?: 'utf-8' | 'utf8') =>
      encoding ? nfs.readFile(path, encoding) : nfs.readFile(path)) as PodFs['readFile'],
    writeFile: (path, data) =>
      typeof data === 'string' ? nfs.writeFile(path, data, 'utf-8') : nfs.writeFile(path, data),
    mkdir: (path, options) => nfs.mkdir(path, options),
    readdir: ((path: string, options?: { withFileTypes: true }) =>
      options?.withFileTypes ? nfs.readdir(path, { withFileTypes: true }) : nfs.readdir(path)) as PodFs['readdir'],
    stat: (path) => nfs.stat(path),
    rm: (path, options) => nfs.rm(path, options),
    rename: (oldPath, newPath) => nfs.rename(oldPath, newPath),
  };
}
