/** Persistent overlay directories live INSIDE the encrypted browser root. */
import type { ZenFsLike } from '../sandbox/types.js';
import { resolveStorageContext, registerStorageProjection, type StorageContext } from './context.js';
import { directoryMount, directoryStore } from './directory-store.js';
import { encryptedStoreMount } from './encrypted-store.js';

/** Legacy source locator; this unkeyed digest is not an encryption boundary. */
export async function upperDirName(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`artipod-upper:${id}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}

export function workspaceUpperPaths(ref: string) {
  if (typeof ref !== 'string' || !ref || ref === '.' || ref === '..' || ref.includes('\0')) {
    throw new Error('Invalid workspace reference: expected a nonempty string without dot segments or NUL');
  }
  const container = `/.artipod/workspace-uppers/${encodeURIComponent(ref)}`;
  return { directory: `${container}/tree`, committed: `${container}/ready` };
}

async function isCommitted(fs: ZenFsLike, marker: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(marker);
    if (!stat.isFile() || await fs.promises.readFile(marker, 'utf8') !== '1') {
      throw new Error('Workspace migration commit record is invalid; preserving saved copies');
    }
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return false;
    throw error;
  }
}

export async function openWorkspaceUpper(options: {
  storage: StorageContext;
  ref: string;
  getKey: () => CryptoKey;
}) {
  const { ref, getKey } = options;
  const { directory, committed } = workspaceUpperPaths(ref);
  const context = resolveStorageContext(options.storage);
  const fs = context.zfs;
  const flush = () => context.flush();
  const p = fs.promises;
  const legacyTree = `/.artipod/uppers/${encodeURIComponent(ref)}`;
  const legacyBlocks = `/.artipod/uppers/${await upperDirName(ref)}`;
  if (!(await isCommitted(fs, committed))) {
    const hasTree = await p.exists(legacyTree);
    const hasBlocks = await p.exists(legacyBlocks);
    if (hasTree && hasBlocks) throw new Error('Conflicting legacy workspace copies require recovery before opening');
    if (hasBlocks) {
      // StoreFS creates an empty root when block zero is absent. A legacy
      // upper must prove it has an existing root before mounting it so that
      // a damaged source cannot become an empty, successfully migrated tree.
      try {
        const bytes = new Uint8Array(await p.readFile(`${legacyBlocks}/0`));
        if (bytes.length === 0) throw new Error('Legacy workspace root block is empty; saved blocks were preserved');
      } catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') {
          throw new Error('Legacy workspace root block is missing; saved blocks were preserved', { cause: error });
        }
        throw error;
      }
    }
    // A directory without its commit record is an interrupted migration, not
    // a ready workspace. Its original source has not been retired yet.
    if (await p.exists(directory)) await p.rm(directory, { recursive: true });
    await p.mkdir(directory, { recursive: true });
    // Preserve both copies on failure. Retry may discard a staging directory
    // only after proving that its commit record is absent.
    if (hasTree) {
      await copyTree(fs, legacyTree, directory);
    } else if (hasBlocks) {
      if (context.protection !== 'encrypted') throw new Error('A key is required to migrate the encrypted workspace');
      const inner = await directoryStore({ zfs: fs, directory: legacyBlocks, flush });
      // Legacy IndexedDB mounts initialized their root inode before wrapping
      // encryption, so some otherwise encrypted uppers contain plaintext
      // bootstrap blocks. Adopt those ONLY as migration input; every output
      // write remains inside the strictly encrypted browser root.
      const old = await encryptedStoreMount({ backing: { kind: 'store', store: inner }, getKey, assertAccess: () => { getKey(); } });
      // Copy from the old block filesystem through logical files. These
      // writes already pass through the encrypted root; no raw staging.
      await copyMountedTree(old, fs, directory);
    }
    await flush();
    await p.writeFile(committed, '1');
    await flush();
  }
  if (!(await p.exists(directory))) throw new Error('Committed workspace backing is missing');
  // Cleanup is resumable after the new generation has committed; a failure
  // here must never remove the verified destination.
  if (await p.exists(legacyTree)) await p.rm(legacyTree, { recursive: true });
  if (await p.exists(legacyBlocks)) await p.rm(legacyBlocks, { recursive: true });
  await flush();
  const source = await directoryMount(fs, directory);
  // A directory view holds the original backend directly. Gate its cached
  // methods too, including volatile roots whose backend has no lease checks.
  const root = new Proxy(source, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function' || property === 'constructor') return value;
      return (...args: unknown[]) => { context.assertAccess(); return Reflect.apply(value, target, args); };
    },
  });
  registerStorageProjection(root, context);
  return root;
}

async function copyTree(fs: ZenFsLike, source: string, destination: string): Promise<void> {
  const p = fs.promises;
  for (const name of await p.readdir(source)) {
    const from = `${source}/${name}`;
    const to = `${destination}/${name}`;
    const stat = await p.lstat(from);
    if (stat.isDirectory()) {
      await p.mkdir(to, { recursive: true });
      await copyTree(fs, from, to);
      await p.chmod(to, stat.mode & 0o777);
      if (p.utimes) await p.utimes(to, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    } else if (stat.isSymbolicLink()) {
      const target = await p.readlink(from);
      await p.symlink(target, to);
      if (await p.readlink(to) !== target) throw new Error('Workspace link migration failed');
    } else if (stat.isFile()) {
      const bytes = new Uint8Array(await p.readFile(from));
      await p.writeFile(to, bytes);
      const actual = new Uint8Array(await p.readFile(to));
      if (bytes.length !== actual.length || bytes.some((byte, i) => byte !== actual[i])) throw new Error('Workspace migration verification failed');
      await p.chmod(to, stat.mode & 0o777);
      if (p.utimes) await p.utimes(to, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    } else throw new Error('Unsupported workspace migration entry');
  }
}

async function copyMountedTree(source: import('@zenfs/core').FileSystem, fs: ZenFsLike, destination: string): Promise<void> {
  const p = fs.promises;
  const visit = async (from: string, to: string) => {
    const stat = await source.stat(from);
    if ((stat.mode & 0o170000) === 0o040000) {
      await p.mkdir(to, { recursive: true });
      for (const name of await source.readdir(from)) await visit(`${from === '/' ? '' : from}/${name}`, `${to}/${name}`);
      await p.chmod(to, stat.mode & 0o777);
      if (p.utimes) await p.utimes(to, Number(stat.atimeMs) / 1000, Number(stat.mtimeMs) / 1000);
    } else if ((stat.mode & 0o170000) === 0o100000) {
      const bytes = new Uint8Array(Number(stat.size));
      await source.read(from, bytes, 0, bytes.length);
      await p.writeFile(to, bytes);
      const actual = new Uint8Array(await p.readFile(to));
      if (bytes.length !== actual.length || bytes.some((byte, i) => byte !== actual[i])) throw new Error('Encrypted workspace migration verification failed');
      await p.chmod(to, stat.mode & 0o777);
      if (p.utimes) await p.utimes(to, Number(stat.atimeMs) / 1000, Number(stat.mtimeMs) / 1000);
    } else {
      // StoreFS symlinks carry their target as file bytes.
      if ((stat.mode & 0o170000) !== 0o120000) throw new Error('Unsupported encrypted workspace entry');
      const bytes = new Uint8Array(Number(stat.size));
      await source.read(from, bytes, 0, bytes.length);
      await p.symlink(new TextDecoder().decode(bytes), to);
    }
  };
  await visit('/', destination);
}
