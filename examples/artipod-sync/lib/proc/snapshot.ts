/**
 * The `/proc` snapshot.
 *
 * `/proc` is a plain in-memory ZenFS mount that is thrown away and rebuilt from
 * the enabled providers before every command — a snapshot, not a live procfs.
 * Implementing a real ZenFS `FileSystem` would mean 24 abstract methods in
 * sync+async pairs for no gain: nothing observes the tree between commands.
 */
import { enabledProviders, providerRoot, type ProcProvider, type ProcTree } from './registry';
import type { ZenFsLike } from '../sandbox/types';

export const PROC_MOUNT = '/proc';

/** One file as it stood at the last refresh — the reconcile baseline. */
export interface ProcEntry {
  provider: ProcProvider;
  /** Path relative to the provider root. */
  rel: string;
  hash: string;
}

const entries = new Map<string, ProcEntry>();

/** Absolute path → what the last refresh wrote there. */
export function procEntries(): ReadonlyMap<string, ProcEntry> {
  return entries;
}

export function procPathOf(provider: ProcProvider, rel: string): string {
  const root = providerRoot(provider);
  return root ? `${PROC_MOUNT}/${root}/${rel}` : `${PROC_MOUNT}/${rel}`;
}

/**
 * `mkdir -p` + write for a whole tree. Pure with respect to the mount table, so
 * apps reuse it to materialize persistent directories too.
 */
export async function writeTree(zfs: ZenFsLike, root: string, files: ProcTree): Promise<void> {
  await mkdirp(zfs, root);
  for (const [rel, content] of Object.entries(files)) {
    const path = root === '/' ? `/${rel}` : `${root}/${rel}`;
    const slash = path.lastIndexOf('/');
    if (slash > 0) await mkdirp(zfs, path.slice(0, slash));
    await zfs.promises.writeFile(path, content as Parameters<ZenFsLike['promises']['writeFile']>[1]);
  }
}

export async function mkdirp(zfs: ZenFsLike, dir: string): Promise<void> {
  if (dir === '' || dir === '/') return;
  try {
    await zfs.promises.mkdir(dir, { recursive: true });
  } catch (e) {
    if ((e as { code?: string }).code !== 'EEXIST') throw e;
  }
}

/**
 * Rebuilds `/proc` from the enabled providers. A provider that throws is
 * skipped with its message returned, rather than taking the whole tree down.
 */
export async function refreshProc(zfs: ZenFsLike): Promise<string[]> {
  const { mount, mounts, umount, resolveMountConfig, InMemory } = await import('@zenfs/core');
  if (mounts.has(PROC_MOUNT)) umount(PROC_MOUNT);
  // ZenFS only exposes a mount point that exists as a directory underneath, and
  // the mkdir has to happen before the mount or it lands inside it.
  await mkdirp(zfs, PROC_MOUNT);
  mount(PROC_MOUNT, await resolveMountConfig({ backend: InMemory }));
  entries.clear();

  const errors: string[] = [];
  for (const provider of enabledProviders()) {
    let tree: ProcTree;
    try {
      tree = await provider.read();
    } catch (e) {
      errors.push(`proc: ${provider.name}: ${(e as Error).message}`);
      continue;
    }
    const root = providerRoot(provider);
    await writeTree(zfs, root ? `${PROC_MOUNT}/${root}` : PROC_MOUNT, tree);
    for (const [rel, content] of Object.entries(tree)) {
      entries.set(procPathOf(provider, rel), { provider, rel, hash: hashContent(content) });
    }
  }
  return errors;
}

export async function unmountProc(): Promise<void> {
  const { mounts, umount } = await import('@zenfs/core');
  if (mounts.has(PROC_MOUNT)) umount(PROC_MOUNT);
  entries.clear();
}

const encoder = new TextEncoder();

export function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? encoder.encode(content) : content;
}

/** Change detection only — a fast non-cryptographic 64-bit FNV-1a pair. */
export function hashContent(content: string | Uint8Array): string {
  const bytes = toBytes(content);
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (const byte of bytes) {
    a = Math.imul(a ^ byte, 0x01000193) >>> 0;
    b = Math.imul(b + byte, 0x85ebca6b) >>> 0;
  }
  return `${a.toString(16)}${b.toString(16)}-${bytes.length}`;
}
