/**
 * ZenFS bootstrap — thin back-compat wrapper over lib/sandbox/storage.ts
 * (backend selection, OPFS/IndexedDB/memory, migration, multi-tab guard).
 *
 * Async-only on purpose: the OPFS backend (WebAccess) is async-mixin based,
 * so no existsSync/mkdirSync may be used anywhere in the app.
 */
import type { InitResult, StorageBackend } from './sandbox/storage';

export type ZenFs = (typeof import('@zenfs/core'))['fs'];

/** Live binding, assigned by initFileSystem(). Use only after init resolves. */
export let fs: ZenFs;

/** Backend + primary-tab info from the last successful init. */
export let fsInfo: InitResult | null = null;

let initPromise: Promise<InitResult> | null = null;

export function initFileSystem(pref?: StorageBackend): Promise<InitResult | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!initPromise) {
    initPromise = init(pref).catch((e) => {
      initPromise = null; // allow retry after a failed init
      throw e;
    });
  }
  return initPromise;
}

async function init(pref?: StorageBackend): Promise<InitResult> {
  const storage = await import('./sandbox/storage');
  const result = await storage.initFileSystem(pref);
  fs = (await import('@zenfs/core')).fs;
  fsInfo = result;
  console.log(`FileSystem initialized (${result.backend}${result.isPrimaryTab ? '' : ', read-only tab'})`);
  return result;
}
