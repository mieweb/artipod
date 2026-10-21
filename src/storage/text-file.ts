import type { ZenFsLike } from '../sandbox/types.js';
import { fs as singleton } from '@zenfs/core';
import { beginRawStorageOperation, captureRawStorageAccess, resolveStorageAccess } from './context.js';

export interface StorageTextFileOptions {
  zfs: ZenFsLike;
  /** Canonical absolute path of the logical text file. */
  path: string;
  /** Caller-reserved fallback in the same directory, used only by this file. */
  previousPath: string;
  /** Independent legacy filesystems own their durability semantics. */
  flush?: () => Promise<void>;
}

const queues = new WeakMap<ZenFsLike, Map<string, Promise<void>>>();
const missing = (error: unknown) => (error as { code?: string })?.code === 'ENOENT';

function bindings(options: StorageTextFileOptions) {
  const canonical = (path: string) => typeof path === 'string' && path.startsWith('/') && !path.includes('\\') && !path.includes('\0') &&
    path.split('/').slice(1).every(part => part !== '' && part !== '.' && part !== '..');
  const { zfs, path, previousPath } = options;
  if (!canonical(path) || !canonical(previousPath) || path === previousPath || path.slice(0, path.lastIndexOf('/')) !== previousPath.slice(0, previousPath.lastIndexOf('/'))) {
    throw new Error('Storage text files require distinct canonical absolute paths in the same directory');
  }
  const storage = resolveStorageAccess(zfs);
  const rawAccess = captureRawStorageAccess(zfs);
  const assertAccess = () => { rawAccess(); resolveStorageAccess(zfs); };
  const drain = storage ? () => storage.flush() : options.flush ?? (async () => {});
  const flush = async () => { assertAccess(); await drain(); };
  const read = async (name: string): Promise<string | null> => {
    assertAccess();
    try { return await zfs.promises.readFile(name, 'utf8') as string; }
    catch (error) { if (missing(error)) return null; throw error; }
  };
  return { zfs, path, previousPath, directory: path.slice(0, path.lastIndexOf('/')) || '/', assertAccess, flush, read };
}

async function withFileQueue<T>(bound: ReturnType<typeof bindings>, operation: () => Promise<T>): Promise<T> {
  const { zfs, path, previousPath } = bound;
  let queue = queues.get(zfs);
  if (!queue) { queue = new Map(); queues.set(zfs, queue); }
  const pair = [path, previousPath].sort().join('\0');
  const before = queue.get(pair) ?? Promise.resolve();
  const running = before.then(() => { bound.assertAccess(); return operation(); });
  const settled = running.then(() => {}, () => {});
  queue.set(pair, settled);
  try { return await running; }
  finally { if (queue.get(pair) === settled) queue.delete(pair); }
}

/** Read the primary or its saved fallback; only definitive absence returns null. */
export async function readStorageTextFile(options: StorageTextFileOptions): Promise<string | null> {
  const bound = bindings(options);
  return withFileQueue(bound, async () => await bound.read(bound.path) ?? await bound.read(bound.previousPath));
}

/**
 * Replace a small text file without overwrite-renaming its saved inode. The
 * fallback is caller-reserved; this is not a general filesystem transaction.
 * Reads and writes to this filesystem/path pair are serialized in this module. A
 * protected context supplies its own durability drain; raw callers own flush
 * semantics and must exclude other writers touching either reserved path.
 */
export async function writeStorageTextFile(options: StorageTextFileOptions, text: string): Promise<void> {
  const bound = bindings(options);
  const { zfs, path, previousPath, directory, assertAccess, flush, read } = bound;
  await withFileQueue(bound, async () => {
    const release = zfs === singleton ? beginRawStorageOperation('Raw text-file replacement cannot overlap managed storage configuration') : () => {};
    try {
      assertAccess();
      await zfs.promises.mkdir(directory, { recursive: true });
      const opaqueSibling = () => `${directory === '/' ? '' : directory}/.${crypto.randomUUID().replace(/-/g, '')}`;
      const temporary = opaqueSibling();
      assertAccess();
      await zfs.promises.writeFile(temporary, text, { flag: 'wx' });
      await flush();
      let current = await read(path);
      const previous = await read(previousPath);
      if (current === null && previous !== null) {
        assertAccess();
        await zfs.promises.rename(previousPath, path);
        await flush();
        current = previous;
      } else if (previous !== null) {
        // Retire before unlinking: a failed directory commit may leave an opaque
        // orphan, but cannot leave a dangling primary or fallback name.
        const retired = opaqueSibling();
        assertAccess();
        await zfs.promises.rename(previousPath, retired);
        await flush();
        assertAccess();
        await zfs.promises.unlink(retired);
        await flush();
      }
      if (current !== null) {
        assertAccess();
        await zfs.promises.rename(path, previousPath);
        await flush();
      }
      // Destinations are absent. ZenFS overwrite rename deletes the old inode
      // before its directory commit, so never use it for either reserved name.
      assertAccess();
      await zfs.promises.rename(temporary, path);
      await flush();
    } finally { release(); }
  });
}
