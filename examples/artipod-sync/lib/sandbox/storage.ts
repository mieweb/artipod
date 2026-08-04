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
const IDB_STORE = 'browser-git-fs';
const MIGRATE_MOUNT = '/__migrate';

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
    return { backend: WebAccess, handle: await navigator.storage.getDirectory() };
  }
  return { backend: IndexedDB, storeName: IDB_STORE };
}

export interface InitResult {
  backend: StorageBackend;
  /** False when another tab already owns the filesystem (read-only mode). */
  isPrimaryTab: boolean;
}

let releaseLock: (() => void) | null = null;

/**
 * Single-writer guard: two tabs on one store corrupt state (ZenFS instances
 * don't sync). First tab holds a Web Lock until it closes; later tabs see
 * isPrimaryTab=false and should show a read-only banner.
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
  if (!(await fs.promises.exists('/repo'))) {
    await fs.promises.mkdir('/repo');
  }
  return { backend, isPrimaryTab };
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
  const { fs, mount, umount } = await import('@zenfs/core');
  const p = fs.promises;

  // Attach the target as a nested mount, then walk-copy (skipping the mount itself).
  const { resolveMountConfig } = await import('@zenfs/core');
  const targetFs = await resolveMountConfig(await mountConfigFor(to));
  mount(MIGRATE_MOUNT, targetFs);

  try {
    const files: string[] = [];
    const dirs: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const name of await p.readdir(dir)) {
        const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
        if (path === MIGRATE_MOUNT) continue;
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
    await walk('/');

    let copied = 0;
    let bytes = 0;
    for (const dir of dirs) {
      await p.mkdir(`${MIGRATE_MOUNT}${dir}`, { recursive: true });
    }
    for (const file of files) {
      const data = await p.readFile(file);
      await p.writeFile(`${MIGRATE_MOUNT}${file}`, data);
      bytes += data.byteLength;
      copied++;
      onProgress?.({ copied, total: files.length, currentPath: file });
    }

    // Verify: every file exists on the target with the same size.
    for (const file of files) {
      const st = await p.stat(`${MIGRATE_MOUNT}${file}`);
      const src = await p.stat(file);
      if (st.size !== src.size) {
        throw new Error(`migration verify failed for ${file}: ${st.size} != ${src.size}`);
      }
    }

    saveBackendPref(to);
    return { files: files.length, bytes };
  } finally {
    umount(MIGRATE_MOUNT);
  }
}

export interface StorageUsage {
  usage: number;
  quota: number;
  persisted: boolean;
}

export async function getStorageUsage(): Promise<StorageUsage | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return { usage, quota, persisted };
}

export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  return navigator.storage.persist();
}
