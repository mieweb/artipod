/**
 * The browser's entire logical root is an encrypted block store. Metadata,
 * scratch and catalog writes share the same persistence boundary as files.
 */
import type { BrowserVaultResetResult, InitResult, StorageBackend, ZenFsLike } from '@artipod/core/sandbox';

export type ZenFs = ZenFsLike;

/** Live binding, assigned by initFileSystem(). Use only after init resolves. */
export let fs: ZenFs;

/** Backend + primary-tab info from the last successful init. */
export let fsInfo: InitResult | null = null;

let initPromise: Promise<InitResult> | null = null;
let flushRoot: (() => Promise<void>) | null = null;
let closeRoot: (() => Promise<void>) | null = null;
let adoptRootKey: (() => Promise<void>) | null = null;
let resetRoot: (() => Promise<BrowserVaultResetResult>) | null = null;
let resetPromise: Promise<BrowserVaultResetResult> | null = null;
let resetting = false;

export function initFileSystem(pref?: StorageBackend): Promise<InitResult | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (resetting) return Promise.reject(new Error('Browser storage reset is in progress; reload before opening storage'));
  if (!initPromise) {
    initPromise = init(pref).catch(async (e) => {
      try { await closeRoot?.(); } catch { /* Preserve the original opening error. */ }
      closeRoot = null;
      flushRoot = null;
      adoptRootKey = null;
      resetRoot = null;
      fsInfo = null;
      initPromise = null; // allow retry after a failed init
      throw e;
    });
  }
  return initPromise.then(async result => {
    await adoptRootKey?.();
    await flushRoot?.();
    const { keys } = await import('./boot');
    await keys().flushOfflinePreference();
    return result;
  });
}

async function init(pref?: StorageBackend): Promise<InitResult> {
  const storage = await import('@artipod/core/sandbox');
  const { keys } = await import('./boot');
  const svc = keys();
  const required = await storage.browserVaultRequired();
  let result: InitResult;
  if (svc.getKey()) {
    const preferred = pref ?? storage.loadBackendPref();
    const vault = await storage.openBrowserVault({
      getKey: svc.requireKey,
      backend: preferred === 'opfs' || preferred === 'indexeddb' ? preferred : undefined,
    });
    try {
      flushRoot = vault.flush;
      closeRoot = vault.close;
      adoptRootKey = vault.adoptKey;
      resetRoot = vault.reset;
      fs = durableFileSystem(await storage.configureStorageRoot(vault.filesystem, { protectedPersistence: true }));
    } catch (error) {
      await vault.close();
      throw error;
    }
    result = { backend: vault.backend, zfs: fs, isPrimaryTab: true, encrypted: true };
  } else {
    if (required || svc.storagePolicy === 'encrypted') {
      throw new Error('An encryption key is required to open or migrate saved local workspaces. Log in to restore access.');
    }
    // A plaintext or unreachable server cannot authorize persistent plaintext
    // storage. The UI identifies this volatile workspace before accepting edits.
    fs = await storage.configureStorageRoot(await storage.createMemoryStorageRoot(), { protectedPersistence: true });
    flushRoot = async () => {};
    result = { backend: 'memory', zfs: fs, isPrimaryTab: true, encrypted: false, memoryOnly: true };
  }
  await fs.promises.mkdir('/repo', { recursive: true });
  await flushRoot?.();
  fsInfo = result;
  svc.setOfflineWriter(async value => {
    const { writePodSettings } = await import('@artipod/core/oci');
    await writePodSettings(fs as unknown as Parameters<typeof writePodSettings>[0], { offline: value });
    await flushFileSystem();
  });
  return result;
}

/** Explicit durability boundary for shell, editor, publish and registry writes. */
export async function flushFileSystem(): Promise<void> {
  if (resetting) throw new Error('Browser storage reset is in progress');
  await flushRoot?.();
}

/** Confirmed reset holds vault ownership through erasure, including failed flushes. */
export function resetFileSystem(): Promise<BrowserVaultResetResult> {
  if (resetPromise) return resetPromise;
  resetting = true;
  const opening = initPromise;
  resetPromise = (async () => {
    let finishKeys: (() => void) | undefined;
    try {
      // If opening already started, use its eventual owned handle. A rejected
      // open releases ownership; standalone reset must reacquire both locks.
      try { await opening; } catch { /* Reset also works for locked/corrupt storage. */ }
      const { keys } = await import('./boot');
      const svc = keys();
      svc.setOfflineWriter(null);
      // Key/grant persistence has its own IndexedDB connections. Stop and
      // drain those jobs too, retaining the live key until vault I/O settles.
      finishKeys = await svc.suspendForReset();
      if (resetRoot) return await resetRoot();
      const storage = await import('@artipod/core/sandbox');
      return await storage.resetBrowserVault();
    } finally {
      finishKeys?.();
      closeRoot = null; flushRoot = null; adoptRootKey = null; resetRoot = null; initPromise = null; fsInfo = null;
      resetPromise = null;
    }
  })();
  return resetPromise;
}

export async function closeFileSystem(): Promise<void> {
  if (resetPromise) { await resetPromise; return; }
  try { await closeRoot?.(); }
  finally {
    const { keys } = await import('./boot');
    keys().setOfflineWriter(null);
    closeRoot = null; flushRoot = null; adoptRootKey = null; resetRoot = null; initPromise = null; fsInfo = null;
  }
}

function durableFileSystem(source: ZenFs): ZenFs {
  const mutations = new Set(['writeFile', 'appendFile', 'mkdir', 'rename', 'rm', 'unlink', 'rmdir', 'chmod', 'chown', 'utimes', 'symlink', 'link', 'truncate']);
  const promises = new Proxy(source.promises, {
    get(target, property) {
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      if (!mutations.has(String(property))) return method.bind(target);
      return async (...args: unknown[]) => {
        if (resetting) throw new Error('Browser storage reset is in progress');
        const result = await method.apply(target, args);
        await flushFileSystem();
        return result;
      };
    },
  });
  return new Proxy(source, {
    get(target, property) { return property === 'promises' ? promises : Reflect.get(target, property); },
  });
}
