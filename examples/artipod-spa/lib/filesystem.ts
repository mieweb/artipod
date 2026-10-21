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
let recoveryPromise: Promise<{ info: InitResult; warning: string }> | null = null;
let rootFailure: unknown = null;
let rootGeneration = 0;
const sessionTeardowns = new Map<() => Promise<void>, string>();

/** A consumer disposed successfully, but its final persistence drain failed. */
export class FileSystemClosePersistenceError extends Error {
  constructor(cause: unknown) { super('Workspace storage could not flush before closing', { cause }); }
}

/** Retain teardown until it settles, even when React has already unmounted. */
export function registerFileSystemTeardown(close: () => Promise<void>, source = 'Storage consumer'): () => Promise<void> {
  let closing: Promise<void> | null = null;
  const teardown = () => closing ??= Promise.resolve().then(close).then(() => { sessionTeardowns.delete(teardown); });
  sessionTeardowns.set(teardown, source);
  return teardown;
}

export function fileSystemNeedsRecovery(): boolean { return rootFailure !== null; }

function clearRoot(): void {
  rootGeneration += 1;
  closeRoot = null; flushRoot = null; adoptRootKey = null; resetRoot = null; initPromise = null; fsInfo = null;
}

function openingRoot(pref?: StorageBackend): Promise<InitResult> {
  return init(pref).catch(async error => {
    try { await closeRoot?.(); } catch { /* Preserve the original opening error. */ }
    clearRoot();
    throw error;
  });
}

export function initFileSystem(pref?: StorageBackend): Promise<InitResult | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (resetting) return Promise.reject(new Error('Browser storage reset is in progress; reload before opening storage'));
  if (recoveryPromise) return Promise.reject(new Error('Browser storage recovery is in progress'));
  if (!initPromise) initPromise = openingRoot(pref);
  const opening = initPromise;
  return opening.then(async result => {
    const generation = rootGeneration;
    const adopt = adoptRootKey;
    const flush = flushRoot;
    const ownsRoot = () => !resetting && !recoveryPromise && generation === rootGeneration && opening === initPromise && result === fsInfo;
    const assertCurrent = () => {
      if (!ownsRoot()) throw new Error('Browser storage changed while initialization was completing; retry opening storage');
    };
    const current = async <T>(operation: () => T | Promise<T>): Promise<T> => {
      assertCurrent();
      try { return await operation(); }
      finally { assertCurrent(); }
    };
    await current(() => adopt?.());
    try { await current(() => flush?.()); }
    catch (error) { if (ownsRoot() && result.encrypted) rootFailure = error; throw error; }
    const { keys } = await current(() => import('./boot'));
    await current(() => keys().flushOfflinePreference());
    return result;
  });
}

/** Authenticate, dispose consumers, and reopen persisted blocks without a reload. */
export function recoverFileSystem(pref?: StorageBackend): Promise<{ info: InitResult; warning: string }> {
  if (resetting) return Promise.reject(new Error('Browser storage reset is in progress'));
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async () => {
    try {
      const { keys } = await import('./boot');
      const svc = keys();
      svc.requireKey();
      // A changed or missing key must never release the current mount merely
      // to substitute an unauthenticated generation.
      await adoptRootKey?.();
      rootGeneration += 1;
      svc.setOfflineWriter(null);
      // Session close may report the same sticky write failure, but its
      // teardown still disposes mounts/providers before this root is replaced.
      const consumers = [...sessionTeardowns];
      const teardowns = await Promise.allSettled(consumers.map(([close]) => close()));
      for (let index = 0; index < teardowns.length; index += 1) {
        const result = teardowns[index];
        if (result.status === 'rejected' && result.reason !== rootFailure && !(result.reason instanceof FileSystemClosePersistenceError)) {
          throw new Error(`${consumers[index][1]} teardown failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`, { cause: result.reason });
        }
        // A disposed consumer may report a flush failure from when its key
        // was still locked. Its explicit persistence-only type is safe too.
        if (result.status === 'rejected') sessionTeardowns.delete(consumers[index][0]);
      }
      try { await closeRoot?.(); }
      catch (error) { if (error !== rootFailure) throw new Error('Failed vault could not close', { cause: error }); }
      finally { clearRoot(); }
      initPromise = openingRoot(pref);
      const info = await initPromise;
      await svc.flushOfflinePreference();
      rootFailure = null;
      return {
        info,
        warning: 'Storage reopened from its saved generation after a failed write. Some changes could not be saved; editor drafts remain in this tab. Review and save them again.',
      };
    } catch (error) {
      throw new Error(`Storage recovery failed: ${error instanceof Error ? error.message : String(error)}. Unsaved editor drafts remain in this tab; keep this page open and retry.`, { cause: error });
    } finally { recoveryPromise = null; }
  })();
  return recoveryPromise;
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
  if (recoveryPromise) return Promise.reject(new Error('Browser storage recovery is in progress'));
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
      clearRoot();
      resetPromise = null;
    }
  })();
  return resetPromise;
}

export async function closeFileSystem(): Promise<void> {
  if (resetPromise) { await resetPromise; return; }
  if (recoveryPromise) { await recoveryPromise; return; }
  try { await closeRoot?.(); }
  finally {
    const { keys } = await import('./boot');
    keys().setOfflineWriter(null);
    clearRoot();
  }
}

function durableFileSystem(source: ZenFs): ZenFs {
  const generation = rootGeneration;
  const persist = flushRoot ?? (async () => {});
  const assertCurrent = () => {
    if (resetting) throw new Error('Browser storage reset is in progress');
    if (generation !== rootGeneration) throw new Error('Browser storage mount was closed for recovery');
  };
  const mutations = new Set(['writeFile', 'appendFile', 'mkdir', 'rename', 'rm', 'unlink', 'rmdir', 'chmod', 'chown', 'utimes', 'symlink', 'link', 'truncate']);
  const promises = new Proxy(source.promises, {
    get(target, property) {
      const method = Reflect.get(target, property);
      if (typeof method !== 'function') return method;
      return async (...args: unknown[]) => {
        assertCurrent();
        const result = await method.apply(target, args);
        if (mutations.has(String(property))) await persist();
        return result;
      };
    },
  });
  return new Proxy(source, {
    get(target, property) {
      if (property === 'promises') return promises;
      const method = Reflect.get(target, property, target);
      return typeof method !== 'function' ? method : (...args: unknown[]) => { assertCurrent(); return method.apply(target, args); };
    },
  });
}
