/** Framework-free owner of one protected filesystem, its consumers and key lifetime. */
import type { FileSystem } from '@zenfs/core';
import type { ZenFsLike } from '../sandbox/types.js';
import { configureStorageRoot, createMemoryStorageRoot } from '../sandbox/storage.js';
import { writePodSettings } from '../oci/settings.js';
import { browserVaultRequired, openBrowserVault, resetBrowserVault, type BrowserVault, type BrowserVaultAdapters, type BrowserVaultBackend, type BrowserVaultResetResult } from './browser-vault.js';
import { invalidateStorageContext, registerStorageContext, registerStorageRoot, type StorageContext, type StoragePolicy } from './context.js';
import type { StorageKeyProvider } from './keys.js';
import { openWorkspaceUpper, workspaceUpperPaths } from './workspace.js';

export interface StorageSessionOptions {
  /** Persistent encryption is mandatory by default. Broker mode permits memory only after a definitive no-broker response. */
  policy?: StoragePolicy | 'broker';
  keys?: StorageKeyProvider;
  /** Raw backing only: encryption always belongs to core. Omit for browser OPFS/IndexedDB. */
  adapters?: BrowserVaultAdapters;
  backend?: BrowserVaultBackend;
  /** Required for an explicit plaintext session. Never treated as protected. */
  filesystem?: FileSystem;
}
export interface StorageSessionInfo extends StorageContext {
  /** Promise and synchronous file operations; callbacks, streams, watchers and directory iterators are unsupported. Await flush() after synchronous mutations. */
  readonly zfs: ZenFsLike;
  readonly encrypted: boolean;
  readonly memoryOnly: boolean;
  readonly isPrimaryTab: true;
}
export interface StorageSessionSnapshot {
  status: 'closed' | 'opening' | 'open' | 'locked' | 'recovering' | 'resetting' | 'failed';
  protection?: StorageContext['protection'];
  backend?: string;
  needsRecovery: boolean;
}

/** A consumer disposed successfully, but its final persistence drain failed. */
export class StorageClosePersistenceError extends Error {
  constructor(cause: unknown) { super('Workspace storage could not flush before closing', { cause }); }
}

export function createStorageSession(options: StorageSessionOptions = {}): StorageSession { return new StorageSession(options); }

export class StorageSession {
  private opening: Promise<StorageSessionInfo> | null = null;
  private initializing = 0;
  private info: StorageSessionInfo | null = null;
  private vault: BrowserVault | null = null;
  private epoch = 0;
  private owned = false;
  private ownership = 0;
  private failure: unknown = null;
  private resetting = false;
  private resetPromise: Promise<BrowserVaultResetResult> | null = null;
  private recovery: Promise<{ info: StorageSessionInfo; warning: string }> | null = null;
  private recoveryEpoch: number | null = null;
  private closing: Promise<void> | null = null;
  private state: StorageSessionSnapshot['status'] = 'closed';
  private readonly listeners = new Set<() => void>();
  private readonly consumers = new Map<() => Promise<void>, string>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly handles = new Set<{ close(): Promise<unknown> }>();
  private readonly descriptors = new Map<ZenFsLike, Map<number, () => void>>();
  private readonly sourceReleases = new Set<() => void>();
  private unsubscribeKeys: (() => void) | undefined;
  private snapshot: StorageSessionSnapshot = { status: 'closed', needsRecovery: false };

  private readonly options: Readonly<StorageSessionOptions>;
  constructor(options: StorageSessionOptions = {}) { this.options = Object.freeze({ ...options }); }

  getSnapshot = (): StorageSessionSnapshot => {
    const next: StorageSessionSnapshot = { status: this.info && !this.options.keys?.getKey() && this.info.encrypted && this.state === 'open' ? 'locked' : this.state,
      ...(this.info ? { protection: this.info.protection, backend: this.info.backend } : {}), needsRecovery: this.needsRecovery() };
    if (Object.keys(next).some(key => next[key as keyof StorageSessionSnapshot] !== this.snapshot[key as keyof StorageSessionSnapshot]) || Object.keys(this.snapshot).length !== Object.keys(next).length) this.snapshot = next;
    return this.snapshot;
  };
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(state = this.state): void { this.state = state; for (const listener of this.listeners) listener(); }
  needsRecovery = (): boolean => this.failure !== null;

  registerTeardown(close: () => Promise<void>, source = 'Storage consumer'): () => Promise<void> {
    let closing: Promise<void> | null = null;
    const teardown = () => closing ??= Promise.resolve().then(close).then(() => { this.consumers.delete(teardown); });
    this.consumers.set(teardown, source);
    return teardown;
  }

  open(): Promise<StorageSessionInfo> {
    if (this.resetting) return Promise.reject(new Error('Browser storage reset is in progress; reload before opening storage'));
    if (this.recovery) return Promise.reject(new Error('Browser storage recovery is in progress'));
    if (this.closing) return Promise.reject(new Error('Storage is closing'));
    if (!this.opening) {
      this.initializing += 1;
      this.publish('opening');
      this.unsubscribeKeys ??= this.options.keys?.subscribe?.(() => this.publish());
      this.opening = this.initialize().catch(async error => {
        try { await this.vault?.close(); } catch { /* Preserve the opening error. */ }
        this.clear(); this.publish('failed'); throw error;
      }).finally(() => { this.initializing -= 1; });
    }
    const opening = this.opening;
    return opening.then(async result => {
      const epoch = this.epoch;
      const vault = this.vault;
      const owns = () => !this.resetting && !this.recovery && !this.closing && epoch === this.epoch && opening === this.opening && result === this.info;
      const current = async (operation: () => unknown | Promise<unknown>) => {
        if (!owns()) throw new Error('Browser storage changed while initialization was completing; retry opening storage');
        try { await operation(); }
        catch (error) {
          if (!owns()) throw new Error('Browser storage changed while initialization was completing; retry opening storage', { cause: error });
          throw error;
        }
        if (!owns()) throw new Error('Browser storage changed while initialization was completing; retry opening storage');
      };
      await current(() => vault?.adoptKey());
      try { await current(() => vault?.flush()); }
      catch (error) { if (owns() && result.encrypted) { this.failure = error; this.publish('failed'); } throw error; }
      await current(() => this.options.keys?.flushOfflinePreference?.());
      this.publish('open');
      return result;
    });
  }

  private async initialize(): Promise<StorageSessionInfo> {
    const { keys, adapters } = this.options;
    const policy = this.options.policy ?? 'protected';
    let root: FileSystem;
    let backend: string;
    let protection: StorageContext['protection'];
    if (policy === 'plaintext') {
      if (!this.options.filesystem) throw new Error('Plaintext storage requires an explicit caller-provided filesystem');
      root = this.options.filesystem; backend = root.name; protection = 'plaintext';
    } else if (policy === 'memory') {
      root = await createMemoryStorageRoot(); backend = 'memory'; protection = 'volatile';
    } else if (keys?.getKey()) {
      this.vault = await openBrowserVault({ getKey: () => keys.requireKey(), backend: this.options.backend, adapters });
      root = this.vault.filesystem; backend = this.vault.backend; protection = 'encrypted';
    } else {
      if (policy !== 'broker') throw new Error('An encryption key is required to open protected storage');
      const required = adapters ? await adapters.readControl() !== null : await browserVaultRequired();
      if (required || keys?.storagePolicy !== 'plaintext') throw new Error('An encryption key is required to open or migrate saved local workspaces. Log in to restore access.');
      root = await createMemoryStorageRoot(); backend = 'memory'; protection = 'volatile';
    }
    const epoch = this.epoch;
    const ownership = this.ownership;
    const vault = this.vault;
    this.owned = true;
    const assertActive = () => {
      if (this.resetting) throw new Error('Browser storage reset is in progress');
      if (!this.owned || epoch !== this.epoch) throw new Error('Browser storage mount was closed for recovery');
    };
    const assertAccess = () => { assertActive(); vault?.assertAccess(); };
    const assertConsumerAccess = () => {
      assertAccess();
      if (this.closing) throw new Error('Storage is closing');
      if (this.recovery && epoch === this.recoveryEpoch) throw new Error('Browser storage recovery is in progress');
    };
    if (!vault) registerStorageRoot(root, { protection, isOwned: () => this.owned && ownership === this.ownership, assertAccess });
    await configureStorageRoot(root, { protectedPersistence: protection !== 'plaintext', storagePolicy: protection === 'plaintext' ? 'plaintext' : undefined });
    const zen = await import('@zenfs/core');
    const bound = zen.bindContext({ root: '/' });
    const source = bound.fs as unknown as ZenFsLike;
    this.sourceReleases.add(() => {
      for (const handle of bound.descriptors.values()) if (!handle.isClosed) {
        // ZenFS owns these handles. Confirmed reset must be able to discard
        // a dirty cache after its key vanished without attempting another sync.
        (handle as unknown as { disposeSync(force: boolean): void }).disposeSync(true);
      }
      bound.descriptors.clear(); zen.boundContexts.delete(bound.id);
    });
    const persist = async () => {
      try { await vault?.flush(); }
      catch (error) { if (epoch === this.epoch && vault) { this.failure = error; this.publish('failed'); } throw error; }
    };
    const zfs = this.gatedFileSystem(source, assertConsumerAccess, persist);
    const info: StorageSessionInfo = Object.freeze({ zfs, protection, backend, generation: vault?.generation, encrypted: !!vault,
      memoryOnly: protection === 'volatile', isPrimaryTab: true as const, assertAccess: assertConsumerAccess,
      flush: async () => { assertAccess(); await persist(); } });
    registerStorageContext(info, {
      assertActive: assertConsumerAccess,
      wrapFilesystem: (child, release) => {
        assertConsumerAccess();
        if (release) this.sourceReleases.add(release);
        return this.gatedFileSystem(child, assertConsumerAccess, persist);
      },
    });
    this.info = info;
    await zfs.promises.mkdir('/repo', { recursive: true });
    await persist();
    keys?.setOfflineWriter?.(async value => {
      await writePodSettings(zfs as unknown as Parameters<typeof writePodSettings>[0], { offline: value });
      await info.flush();
    });
    return info;
  }

  async flush(): Promise<void> {
    if (this.resetting) throw new Error('Browser storage reset is in progress');
    await this.info?.flush();
  }

  async openWorkspaceUpper(ref: string): Promise<FileSystem> {
    workspaceUpperPaths(ref);
    const info = await this.open();
    return openWorkspaceUpper({ storage: info, ref, getKey: () => this.options.keys!.requireKey() });
  }

  recover(): Promise<{ info: StorageSessionInfo; warning: string }> {
    if (this.resetting) return Promise.reject(new Error('Browser storage reset is in progress'));
    if (this.closing) return Promise.reject(new Error('Storage is closing'));
    if (this.recovery) return this.recovery;
    if (this.initializing || this.state === 'opening') return Promise.reject(new Error('Storage is opening; wait for initialization before recovering'));
    if (!this.info) return Promise.reject(new Error('Open storage before recovering its mounted generation'));
    this.recoveryEpoch = this.epoch;
    this.publish('recovering');
    this.recovery = (async () => {
      try {
        this.options.keys?.requireKey();
        await this.vault?.adoptKey();
        // Authentication may follow lease loss. Drain with the renewed key
        // before comparing teardown errors with the queue's retained failure.
        try { await this.vault?.flush(); }
        catch (error) { this.failure = error; }
        this.epoch += 1;
        this.options.keys?.setOfflineWriter?.(null);
        await this.disposeConsumers(true);
        await Promise.allSettled([...this.operations]);
        await this.closeHandles(true);
        try { await this.vault?.close(); }
        catch (error) { if (error !== this.failure) throw new Error('Failed vault could not close', { cause: error }); }
        finally { this.clear(); }
        this.opening = this.initialize().catch(async error => {
          try { await this.vault?.close(); } catch { /* Preserve original failure. */ }
          this.clear(); throw error;
        });
        const info = await this.opening;
        await this.options.keys?.flushOfflinePreference?.();
        this.failure = null; this.publish('open');
        return { info, warning: 'Storage reopened from its saved generation after a failed write. Some changes could not be saved; editor drafts remain in this tab. Review and save them again.' };
      } catch (error) {
        this.publish('failed');
        throw new Error(`Storage recovery failed: ${error instanceof Error ? error.message : String(error)}. Unsaved editor drafts remain in this tab; keep this page open and retry.`, { cause: error });
      } finally { this.recovery = null; this.recoveryEpoch = null; }
    })();
    return this.recovery;
  }

  private async disposeConsumers(acknowledgePersistence = false): Promise<string[]> {
    const warnings: string[] = [];
    const consumers = [...this.consumers];
    const results = await Promise.allSettled(consumers.map(([close]) => close()));
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === 'rejected') {
        if (!acknowledgePersistence || (result.reason !== this.failure && !(result.reason instanceof StorageClosePersistenceError))) {
          throw new Error(`${consumers[index][1]} teardown failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`, { cause: result.reason });
        }
        this.consumers.delete(consumers[index][0]);
        warnings.push(`${consumers[index][1]} could not save all changes before closing: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }
    return warnings;
  }

  reset(): Promise<BrowserVaultResetResult> {
    if (this.resetPromise) return this.resetPromise;
    if (this.recovery || this.closing) return Promise.reject(new Error('Browser storage recovery or close is in progress'));
    this.resetting = true; this.publish('resetting');
    const opening = this.opening;
    this.resetPromise = (async () => {
      let finishKeys: (() => void) | undefined;
      let releasingRoot = false;
      try {
        try { await opening; } catch { /* Reset can erase locked/corrupt storage. */ }
        this.options.keys?.setOfflineWriter?.(null);
        finishKeys = await this.options.keys?.suspendForReset();
        // Disposal failures are material; do not erase while a consumer may still use the root.
        const warnings = await this.disposeConsumers(true);
        await Promise.allSettled([...this.operations]);
        warnings.push(...await this.closeHandles(true, true));
        releasingRoot = true;
        const result = this.vault ? await this.vault.reset()
          : (this.options.policy ?? 'protected') === 'memory' || this.options.policy === 'plaintext' ? { warnings: [] }
          : await resetBrowserVault({ adapters: this.options.adapters });
        this.failure = null;
        return { warnings: [...warnings, ...result.warnings] };
      } finally {
        finishKeys?.();
        if (releasingRoot) this.clear();
        this.resetPromise = null;
        this.publish(releasingRoot ? 'closed' : 'failed');
      }
    })();
    return this.resetPromise;
  }

  close(): Promise<void> {
    if (this.resetPromise) return this.resetPromise.then(() => {});
    if (this.recovery) return this.recovery.then(() => this.close(), () => this.close());
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.opening?.catch(() => {});
      const warnings = await this.disposeConsumers(true);
      await Promise.allSettled([...this.operations]);
      warnings.push(...await this.closeHandles(true));
      try { await this.vault?.close(); }
      finally { this.options.keys?.setOfflineWriter?.(null); this.clear(); this.unsubscribeKeys?.(); this.unsubscribeKeys = undefined; this.publish('closed'); }
      if (warnings.length) throw new StorageClosePersistenceError(new Error(warnings.join('; ')));
    })().finally(() => { this.closing = null; });
    return this.closing;
  }

  private clear(): void {
    if (this.info) invalidateStorageContext(this.info);
    this.releaseSources(); this.descriptors.clear();
    this.epoch += 1; this.ownership += 1; this.owned = false; this.info = null; this.vault = null; this.opening = null;
  }

  private releaseSources(): void {
    for (const release of this.sourceReleases) { release(); this.sourceReleases.delete(release); }
  }

  private async closeHandles(acknowledgePersistence = false, discardForReset = false): Promise<string[]> {
    const warnings: string[] = [];
    const results = await Promise.allSettled([
      ...[...this.handles].map(handle => handle.close()),
      ...[...this.descriptors.values()].flatMap(descriptors => [...descriptors].map(async ([fd, close]) => { close(); descriptors.delete(fd); })),
    ]);
    // Confirmed erasure may discard unsaved file data. Dispose the known
    // ZenFS descriptors without flushing before treating their close errors
    // as warnings; failures of the actual disposal still stop reset.
    if (discardForReset && results.some(result => result.status === 'rejected')) {
      this.releaseSources(); this.descriptors.clear(); this.handles.clear();
    }
    for (const result of results) if (result.status === 'rejected') {
      if (!discardForReset && (!acknowledgePersistence || (result.reason !== this.failure && !(result.reason instanceof StorageClosePersistenceError)))) throw result.reason;
      warnings.push(`An open file could not save all changes before closing: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
    return warnings;
  }

  private gatedFileSystem(source: ZenFsLike, assertAccess: () => void, persist: () => Promise<void>): ZenFsLike {
    const descriptors = new Map<number, () => void>();
    this.descriptors.set(source, descriptors);
    const mutations = new Set(['open', 'writeFile', 'appendFile', 'mkdir', 'rename', 'rm', 'unlink', 'rmdir', 'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes', 'symlink', 'link', 'truncate', 'mkdtemp', 'copyFile', 'cp']);
    const unsupported = new Set(['watch', 'opendir', 'glob', 'mkdtempDisposable']);
    const promises = new Proxy(source.promises, {
      get: (target, property) => {
        const method = Reflect.get(target, property);
        if (typeof method !== 'function') return method;
        if (unsupported.has(String(property))) return () => { throw new Error('Core storage supports promise and synchronous file operations; directory iterators, callbacks, streams and watchers are unsupported'); };
        return (...args: unknown[]) => {
          const pending = (async () => {
            assertAccess();
            let result: unknown;
            try { result = await method.apply(target, args); }
            catch (error) {
              // ZenFS can report a failed transaction before the explicit
              // durability boundary. Probe the queue to retain its real error.
              if (mutations.has(String(property))) { try { await persist(); } catch { /* Preserve the operation error. */ } }
              throw error;
            }
            if (mutations.has(String(property))) await persist();
            if (property === 'open' && result && typeof result === 'object' && 'close' in result) return this.gatedHandle(result as { close(): Promise<unknown> }, assertAccess, persist);
            return result;
          })();
          this.operations.add(pending);
          void pending.finally(() => this.operations.delete(pending)).catch(() => {});
          return pending;
        };
      },
    });
    return new Proxy(source, { get: (target, property) => {
      if (property === 'promises') return promises;
      const method = Reflect.get(target, property, target);
      if (typeof method !== 'function') return method;
      if (!String(property).endsWith('Sync') || String(property).startsWith('opendir') || String(property).startsWith('glob') || String(property).startsWith('mkdtempDisposable')) return () => { throw new Error('Core storage supports promise and synchronous file operations; directory iterators, callbacks, streams and watchers are unsupported'); };
      return (...args: unknown[]) => {
        assertAccess();
        const result: unknown = method.apply(target, args);
        if (property === 'openSync' && typeof result === 'number') descriptors.set(result, () => source.closeSync(result));
        if (property === 'closeSync') descriptors.delete(args[0] as number);
        return result;
      };
    } });
  }

  private gatedHandle(source: { close(): Promise<unknown> }, assertAccess: () => void, persist: () => Promise<void>): object {
    const mutations = new Set(['write', 'writev', 'writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes', 'datasync', 'sync']);
    let closing: Promise<unknown> | null = null;
    const handle = new Proxy(source, { get: (target, property) => {
      if (property === 'close') return () => closing ??= (async () => {
        try { await target.close(); }
        catch (error) { try { await persist(); } catch { /* Preserve the close error. */ } throw error; }
        await persist();
        this.handles.delete(handle);
      })();
      const method = Reflect.get(target, property, target);
      if (typeof method !== 'function') return method;
      if (['createReadStream', 'createWriteStream', 'readLines', 'readableWebStream'].includes(String(property))) return () => { throw new Error('Core storage file handles do not expose streams or iterators'); };
      return (...args: unknown[]) => {
        const pending = (async () => {
          assertAccess();
          if (closing) throw new Error('Storage file handle is closed');
          let result: unknown;
          try { result = await method.apply(target, args); }
          catch (error) {
            if (mutations.has(String(property))) { try { await persist(); } catch { /* Preserve the operation error. */ } }
            throw error;
          }
          if (mutations.has(String(property))) await persist();
          return result;
        })();
        this.operations.add(pending);
        void pending.finally(() => this.operations.delete(pending)).catch(() => {});
        return pending;
      };
    } });
    this.handles.add(handle);
    return handle;
  }
}
