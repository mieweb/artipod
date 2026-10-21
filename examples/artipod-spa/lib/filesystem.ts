/**
 * The browser's entire logical root is an encrypted block store. Metadata,
 * scratch and catalog writes share the same persistence boundary as files.
 */
import type { InitResult, StorageBackend, ZenFsLike } from '@artipod/core/sandbox';

export type ZenFs = ZenFsLike;

/** Live binding, assigned by initFileSystem(). Use only after init resolves. */
export let fs: ZenFs;

/** Backend + primary-tab info from the last successful init. */
export let fsInfo: InitResult | null = null;

let initPromise: Promise<InitResult> | null = null;
let flushRoot: (() => Promise<void>) | null = null;
let closeRoot: (() => Promise<void>) | null = null;
let adoptRootKey: (() => Promise<void>) | null = null;

export function initFileSystem(pref?: StorageBackend): Promise<InitResult | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!initPromise) {
    initPromise = init(pref).catch(async (e) => {
      try { await closeRoot?.(); } catch { /* Preserve the original opening error. */ }
      closeRoot = null;
      flushRoot = null;
      adoptRootKey = null;
      fsInfo = null;
      initPromise = null; // allow retry after a failed init
      throw e;
    });
  }
  return initPromise.then(async result => {
    await adoptRootKey?.();
    await flushRoot?.();
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
  await flushRoot?.();
}

export async function closeFileSystem(): Promise<void> {
  try { await closeRoot?.(); }
  finally {
    const { keys } = await import('./boot');
    keys().setOfflineWriter(null);
    closeRoot = null; flushRoot = null; adoptRootKey = null; initPromise = null; fsInfo = null;
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
