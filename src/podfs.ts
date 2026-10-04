/**
 * PodFs — the minimal node-shaped promises filesystem a pod runs on.
 *
 * Both `node:fs/promises` (via nodePodFs) and ZenFS's `fs.promises` satisfy
 * this shape structurally. Injecting a PodFs is what makes ArtiMount/ArtiPod
 * isomorphic: the node adapter on real disks, a ZenFS-backed store in
 * browsers and virtual pods.
 */

export interface PodDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface PodStats {
  size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface PodFs {
  readFile(path: string, encoding: 'utf-8' | 'utf8'): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  readdir(path: string, options: { withFileTypes: true }): Promise<PodDirent[]>;
  stat(path: string): Promise<PodStats>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}
