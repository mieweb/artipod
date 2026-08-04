/**
 * ZenFsAdapter — bridges just-bash's IFileSystem contract onto the ZenFS
 * node-like `fs.promises` API.
 *
 * ZenFS stays the single source of truth: the shell sees files through this
 * adapter while isomorphic-git / Monaco / the file tree keep using the same
 * ZenFS instance directly, so all views are always coherent.
 *
 * Errors are passed through unchanged: ZenFS throws node-shaped ErrnoErrors
 * ("ENOENT: No such file or directory, open '/x'"), which is exactly what
 * just-bash matches on.
 */
import type {
  BufferEncoding as JbBufferEncoding,
  CpOptions,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from 'just-bash/browser';
import type { ZenFsLike } from './types';

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

type ReadOptions = { encoding?: JbBufferEncoding | null } | JbBufferEncoding;
type WriteOptions = { encoding?: JbBufferEncoding } | JbBufferEncoding;

function normalizeEncoding(options?: ReadOptions | WriteOptions): JbBufferEncoding | undefined {
  if (!options) return undefined;
  if (typeof options === 'string') return options;
  return options.encoding ?? undefined;
}

/** Pure POSIX path normalization — no fs access (mirrors just-bash path-utils). */
export function normalizePath(path: string): string {
  if (!path || path === '/') return '/';
  let normalized = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  const parts = normalized.split('/').filter((p) => p && p !== '.');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return `/${resolved.join('/')}` || '/';
}

export class ZenFsAdapter implements IFileSystem {
  constructor(private zfs: ZenFsLike) {}

  async readFile(path: string, options?: ReadOptions): Promise<string> {
    const enc = normalizeEncoding(options) ?? 'utf8';
    return (await this.zfs.promises.readFile(path, enc)) as string;
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.zfs.promises.readFile(path));
  }

  async writeFile(path: string, content: string | Uint8Array, options?: WriteOptions): Promise<void> {
    const enc = normalizeEncoding(options);
    if (typeof content === 'string') {
      await this.zfs.promises.writeFile(path, content, enc ?? 'utf8');
    } else {
      await this.zfs.promises.writeFile(path, content);
    }
  }

  async appendFile(path: string, content: string | Uint8Array, options?: WriteOptions): Promise<void> {
    const enc = normalizeEncoding(options);
    if (typeof content === 'string') {
      await this.zfs.promises.appendFile(path, content, enc ?? 'utf8');
    } else {
      await this.zfs.promises.appendFile(path, content);
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.zfs.promises.lstat(path);
      return true;
    } catch {
      return false;
    }
  }

  private toFsStat(s: {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    mode: number;
    size: number;
    mtime: Date;
    dev: number | bigint;
    ino: number | bigint;
  }): FsStat {
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
      mode: s.mode,
      size: s.size,
      mtime: s.mtime,
      dev: s.dev,
      ino: s.ino,
      identity: `${s.dev}:${s.ino}`,
    };
  }

  async stat(path: string): Promise<FsStat> {
    return this.toFsStat(await this.zfs.promises.stat(path));
  }

  async lstat(path: string): Promise<FsStat> {
    return this.toFsStat(await this.zfs.promises.lstat(path));
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    await this.zfs.promises.mkdir(path, { recursive: options?.recursive ?? false });
  }

  async readdir(path: string): Promise<string[]> {
    return await this.zfs.promises.readdir(path);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const dirents = await this.zfs.promises.readdir(path, { withFileTypes: true });
    return dirents.map((d) => ({
      name: d.name,
      isFile: d.isFile(),
      isDirectory: d.isDirectory(),
      isSymbolicLink: d.isSymbolicLink(),
    }));
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    await this.zfs.promises.rm(path, {
      recursive: options?.recursive ?? false,
      force: options?.force ?? false,
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const st = await this.zfs.promises.stat(src);
    if (st.isDirectory() && !options?.recursive) {
      throw new Error(`EISDIR: illegal operation on a directory, cp '${src}'`);
    }
    await this.zfs.promises.cp(src, dest, { recursive: options?.recursive ?? false });
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.zfs.promises.rename(src, dest);
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) return normalizePath(path);
    const combined = base === '/' ? `/${path}` : `${base}/${path}`;
    return normalizePath(combined);
  }

  // Only used by `ls` for unexpanded glob patterns; glob expansion itself is
  // readdir-based. Returning [] degrades that one edge case gracefully.
  getAllPaths(): string[] {
    return [];
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.zfs.promises.chmod(path, mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    await this.zfs.promises.symlink(target, linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.zfs.promises.link(existingPath, newPath);
  }

  async readlink(path: string): Promise<string> {
    return await this.zfs.promises.readlink(path, 'utf8');
  }

  async realpath(path: string): Promise<string> {
    return await this.zfs.promises.realpath(path);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await this.zfs.promises.utimes(path, atime, mtime);
  }
}
