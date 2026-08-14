/**
 * Storage backend selection, detection, migration and the multi-tab guard.
 *
 * Browser-only (uses navigator/localStorage inside functions, never at module
 * top level). ZenFS backends are dynamically imported so nothing heavy or
 * DOM-bound lands in server bundles.
 *
 * Default stays IndexedDB until OPFS e2e is proven (plan §7 risk table);
 * OPFS is opt-in via the settings UI, persisted in localStorage.
 */

export type StorageBackend = 'opfs' | 'indexeddb' | 'memory';

type MountConfig =
  | import('@zenfs/core').MountConfiguration<(typeof import('@zenfs/core'))['InMemory']>
  | import('@zenfs/core').MountConfiguration<(typeof import('@zenfs/dom'))['IndexedDB']>
  | import('@zenfs/core').MountConfiguration<(typeof import('@zenfs/dom'))['WebAccess']>;

const PREF_KEY = 'artipod-sync-storage-backend';
const LOCK_NAME = 'artipod-sync-fs';
/**
 * The default IndexedDB object store. One VFS is *the* filesystem — IndexedDB
 * and OPFS are interchangeable backing devices for it — so the store is named
 * after the filesystem, not after git, which is only one of its consumers.
 */
export const IDB_STORE = 'artipodfs';
/** Pre-`artipodfs` store name; read once at first boot, then never again. */
export const LEGACY_IDB_STORE = 'browser-git-fs';
const MIGRATE_MOUNT = '/__migrate';
const LEGACY_MOUNT = '/__legacy';
/** Sandbox subtree inside OPFS — siblings (artipod-models/) stay invisible to agents. */
export const OPFS_FS_DIR = 'artipod-fs';
export const OPFS_MODELS_DIR = 'artipod-models';

export function loadBackendPref(): StorageBackend | null {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === 'opfs' || v === 'indexeddb' || v === 'memory' ? v : null;
  } catch {
    return null;
  }
}

export function saveBackendPref(backend: StorageBackend): void {
  if (typeof localStorage === 'undefined') return; // Node tests
  localStorage.setItem(PREF_KEY, backend);
}

/** OPFS availability: API presence + a real handle probe (Safari private mode etc). */
export async function supportsOpfs(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return false;
    await navigator.storage.getDirectory();
    return true;
  } catch {
    return false;
  }
}

async function mountConfigFor(backend: StorageBackend): Promise<MountConfig> {
  const { InMemory } = await import('@zenfs/core');
  if (backend === 'memory') return { backend: InMemory };
  const { IndexedDB, WebAccess } = await import('@zenfs/dom');
  if (backend === 'opfs') {
    return { backend: WebAccess, handle: await opfsSandboxDir() };
  }
  return { backend: IndexedDB, storeName: IDB_STORE };
}

/** What `mount -t <type> [-o ...]` resolves to. */
export interface MountSpec {
  type: StorageBackend;
  /** IndexedDB object store. Default: `artipodfs`. */
  store?: string;
  /** OPFS subdirectory below the sandbox dir. Default: the sandbox dir itself. */
  dir?: string;
}

async function mountConfigForSpec(spec: MountSpec): Promise<MountConfig> {
  const { InMemory } = await import('@zenfs/core');
  if (spec.type === 'memory') return { backend: InMemory };
  const { IndexedDB, WebAccess } = await import('@zenfs/dom');
  if (spec.type === 'opfs') {
    let handle = await opfsSandboxDir();
    for (const segment of (spec.dir ?? '').split('/').filter(Boolean)) {
      handle = await handle.getDirectoryHandle(segment, { create: true });
    }
    return { backend: WebAccess, handle };
  }
  return { backend: IndexedDB, storeName: spec.store ?? IDB_STORE };
}

/**
 * Attaches a backing device at `path`. ZenFS only surfaces a mount point that
 * already exists as a directory underneath, and the mkdir has to happen before
 * the mount or it lands inside the new filesystem instead.
 */
export async function mountBackend(path: string, spec: MountSpec): Promise<void> {
  const { fs, mount, mounts, resolveMountConfig } = await import('@zenfs/core');
  if (!path.startsWith('/')) throw new Error(`mount point must be absolute: ${path}`);
  if (mounts.has(path)) throw new Error(`mount point is already in use: ${path}`);
  const resolved = await resolveMountConfig(await mountConfigForSpec(spec));
  if (path !== '/' && !(await fs.promises.exists(path))) {
    await fs.promises.mkdir(path, { recursive: true });
  }
  mount(path, resolved);
}

export async function unmountBackend(path: string): Promise<void> {
  const { mounts, umount } = await import('@zenfs/core');
  if (!mounts.has(path)) throw new Error(`not mounted: ${path}`);
  umount(path);
}

/** The backend kind currently mounted at `path`, or null when nothing is. */
export async function backendAt(path: string): Promise<StorageBackend | null> {
  const { mounts } = await import('@zenfs/core');
  const fs = mounts.get(path);
  if (!fs) return null;
  if (fs.name === 'webaccessfs') return 'opfs';
  if (fs.name === 'tmpfs') return 'memory';
  return 'indexeddb';
}

/**
 * The sandbox mounts the artipod-fs/ SUBDIRECTORY, not the OPFS root, so
 * model weights and other host data can live beside it out of agent reach.
 * Data written by earlier builds (which mounted the root) is moved in once.
 */
async function opfsSandboxDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const fsDir = await root.getDirectoryHandle(OPFS_FS_DIR, { create: true });
  await moveLegacyRootEntries(root, fsDir);
  return fsDir;
}

const KEEP_AT_ROOT = new Set<string>([OPFS_FS_DIR, OPFS_MODELS_DIR]);

async function listEntries(dir: FileSystemDirectoryHandle): Promise<[string, FileSystemHandle][]> {
  const out: [string, FileSystemHandle][] = [];
  const it = (dir as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries();
  while (true) {
    const { done, value } = await it.next();
    if (done) break;
    out.push(value);
  }
  return out;
}

async function copyHandle(
  source: FileSystemHandle,
  destParent: FileSystemDirectoryHandle,
  name: string,
): Promise<void> {
  if (source.kind === 'file') {
    const file = await (source as FileSystemFileHandle).getFile();
    const target = await destParent.getFileHandle(name, { create: true });
    const writable = await target.createWritable();
    await writable.write(file);
    await writable.close();
    return;
  }
  const destDir = await destParent.getDirectoryHandle(name, { create: true });
  for (const [childName, child] of await listEntries(source as FileSystemDirectoryHandle)) {
    await copyHandle(child, destDir, childName);
  }
}

async function moveLegacyRootEntries(
  root: FileSystemDirectoryHandle,
  fsDir: FileSystemDirectoryHandle,
): Promise<void> {
  for (const [name, handle] of await listEntries(root)) {
    if (KEEP_AT_ROOT.has(name)) continue;
    await copyHandle(handle, fsDir, name);
    await root.removeEntry(name, { recursive: true });
  }
}

export interface InitResult {
  backend: StorageBackend;
  /** False when another tab already owns the filesystem. Advisory: writes are not blocked. */
  isPrimaryTab: boolean;
}

let releaseLock: (() => void) | null = null;

/**
 * Single-writer guard: two tabs on one store corrupt state (ZenFS instances
 * don't sync). First tab holds a Web Lock until it closes; later tabs see
 * isPrimaryTab=false and warn the user — nothing stops them writing.
 */
async function acquireSingleWriterLock(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.locks) return true; // older browsers: no guard
  if (releaseLock) return true;
  return new Promise<boolean>((resolve) => {
    navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return;
      }
      resolve(true);
      // Hold the lock for the lifetime of the tab.
      return new Promise<void>((release) => {
        releaseLock = release;
      });
    });
  });
}

export async function initFileSystem(pref?: StorageBackend): Promise<InitResult> {
  const requested = pref ?? loadBackendPref() ?? 'indexeddb';
  const backend: StorageBackend =
    requested === 'opfs' && !(await supportsOpfs()) ? 'indexeddb' : requested;

  const isPrimaryTab = await acquireSingleWriterLock();

  const { configure, fs } = await import('@zenfs/core');
  try {
    await configure({ mounts: { '/': await mountConfigFor(backend) } });
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('Mount point is already in use')) {
      throw e;
    }
  }
  if (backend === 'indexeddb') await adoptLegacyStore();
  if (!(await fs.promises.exists('/repo'))) {
    await fs.promises.mkdir('/repo');
  }
  return { backend, isPrimaryTab };
}

/**
 * One-time `browser-git-fs` → `artipodfs` adoption. Only runs when the new
 * store is untouched, so it can never overwrite live data, and the legacy store
 * is never written to — after this the old name is dead.
 */
async function adoptLegacyStore(): Promise<void> {
  const { fs, mount, mounts, resolveMountConfig, umount } = await import('@zenfs/core');
  const p = fs.promises;
  if (mounts.has(LEGACY_MOUNT) || (await p.readdir('/')).length) return;

  const { IndexedDB } = await import('@zenfs/dom');
  await p.mkdir(LEGACY_MOUNT);
  mount(LEGACY_MOUNT, await resolveMountConfig({ backend: IndexedDB, storeName: LEGACY_IDB_STORE }));
  try {
    if ((await p.readdir(LEGACY_MOUNT)).length) await copyTree(fs, LEGACY_MOUNT, '/');
  } finally {
    umount(LEGACY_MOUNT);
    await p.rmdir(LEGACY_MOUNT).catch(() => undefined);
  }
}

export interface MigrationProgress {
  copied: number;
  total: number;
  currentPath: string;
}

/**
 * Copy everything from the live backend into `to`, verify file count + bytes,
 * flip the preference. Caller must reload the page afterwards.
 */
export async function migrateStorage(
  to: StorageBackend,
  onProgress?: (p: MigrationProgress) => void,
): Promise<{ files: number; bytes: number }> {
  const { fs, mount, resolveMountConfig, umount } = await import('@zenfs/core');

  // Attach the target as a nested mount, then walk-copy (skipping the mount itself).
  mount(MIGRATE_MOUNT, await resolveMountConfig(await mountConfigFor(to)));
  try {
    const result = await copyTree(fs, '/', MIGRATE_MOUNT, onProgress);
    saveBackendPref(to);
    return result;
  } finally {
    umount(MIGRATE_MOUNT);
  }
}

type ZenFs = (typeof import('@zenfs/core'))['fs'];

/**
 * Walk-copy `from` → `to`, skipping nested mount points, then verify every
 * file arrived at the same size. Shared by the backend migration and the
 * legacy-store adoption.
 */
async function copyTree(
  fs: ZenFs,
  from: string,
  to: string,
  onProgress?: (p: MigrationProgress) => void,
): Promise<{ files: number; bytes: number }> {
  const { mounts } = await import('@zenfs/core');
  const p = fs.promises;
  const nested = [...mounts.keys()].filter((m) => m !== from && isBelow(m, from));

  const files: string[] = [];
  const dirs: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of await p.readdir(dir)) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      if (nested.includes(path)) continue;
      const st = await p.lstat(path);
      if (st.isDirectory()) {
        dirs.push(path);
        await walk(path);
      } else if (st.isFile()) {
        files.push(path);
      }
      // symlinks: isomorphic-git materializes none by default; skip safely
    }
  };
  await walk(from);

  const target = (path: string) => {
    const rel = from === '/' ? path : path.slice(from.length);
    return to === '/' ? rel : `${to}${rel}`;
  };

  let copied = 0;
  let bytes = 0;
  for (const dir of dirs) {
    await p.mkdir(target(dir), { recursive: true });
  }
  for (const file of files) {
    const data = await p.readFile(file);
    await p.writeFile(target(file), data);
    bytes += data.byteLength;
    copied++;
    onProgress?.({ copied, total: files.length, currentPath: file });
  }

  for (const file of files) {
    const st = await p.stat(target(file));
    const src = await p.stat(file);
    if (st.size !== src.size) {
      throw new Error(`migration verify failed for ${file}: ${st.size} != ${src.size}`);
    }
  }
  return { files: files.length, bytes };
}

const isBelow = (path: string, root: string) => path.startsWith(root === '/' ? '/' : `${root}/`);

export interface StorageUsage {
  usage: number;
  quota: number;
  persisted: boolean;
  /** Chromium-only per-backend split (`indexedDB`, `fileSystem`, `caches`, ...). */
  details: Record<string, number>;
}

export async function getStorageUsage(): Promise<StorageUsage | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const estimate = (await navigator.storage.estimate()) as StorageEstimate & {
    usageDetails?: Record<string, number>;
  };
  const { usage = 0, quota = 0 } = estimate;
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return { usage, quota, persisted, details: estimate.usageDetails ?? {} };
}

/** Apparent bytes under a top-level OPFS directory, or null when unavailable. */
export async function opfsDirBytes(name: string): Promise<number | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(name); // no create: absent means "no such device"
    return await sumDirBytes(dir);
  } catch {
    return null;
  }
}

async function sumDirBytes(dir: FileSystemDirectoryHandle): Promise<number> {
  let bytes = 0;
  for (const [, handle] of await listEntries(dir)) {
    bytes +=
      handle.kind === 'file'
        ? (await (handle as FileSystemFileHandle).getFile()).size
        : await sumDirBytes(handle as FileSystemDirectoryHandle);
  }
  return bytes;
}

export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
