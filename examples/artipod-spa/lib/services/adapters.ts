/**
 * Injected environment adapters (spa-ui-plan P10): the services layer is the
 * future client lib and must run in the browser AND in node isolates. The
 * ONLY browser-specific things it touches are behind these two interfaces —
 * everything else (fetch, WebCrypto, TextEncoder) is global on node ≥20 too.
 */

/** Structured-clone-capable key/value store (CryptoKeys included): IndexedDB in the browser, a Map in node/tests. */
export interface KeyValue {
  get<T>(key: string): Promise<T | undefined>;
  /** `undefined` deletes. */
  put(key: string, value: unknown): Promise<void>;
}

/** Synchronous string mirror for boot-time flags: localStorage in the browser, a Map in node/tests. */
export interface Mirror {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export interface ServiceAdapters {
  /** The BARE network — the fetch patch wraps around this, never through it. */
  fetch: typeof fetch;
  kv: KeyValue;
  mirror: Mirror;
  /** Origin for same-origin URL matching; '' matches relative URLs only. */
  origin: string;
  now(): number;
}

export function memoryKeyValue(): KeyValue {
  const map = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key, value) => {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
  };
}

export function memoryMirror(): Mirror {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      if (value === null) map.delete(key);
      else map.set(key, value);
    },
  };
}

/** Node/test adapters: everything in memory, network injected per test. */
export function nodeAdapters(overrides: Partial<ServiceAdapters> = {}): ServiceAdapters {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    kv: memoryKeyValue(),
    mirror: memoryMirror(),
    origin: '',
    now: () => Date.now(),
    ...overrides,
  };
}

/** IndexedDB-backed KeyValue (one DB, one store) — ported from the old app's lib/keys.ts. */
export function idbKeyValue(dbName = 'artipod-keys', storeName = 'device'): KeyValue {
  const openDb = (): Promise<IDBDatabase> =>
    new Promise((resolveDb, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName);
      req.onsuccess = () => resolveDb(req.result);
      req.onerror = () => reject(req.error);
    });
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const db = await openDb();
      try {
        return await new Promise<T | undefined>((resolveGet, reject) => {
          const req = db.transaction(storeName).objectStore(storeName).get(key);
          req.onsuccess = () => resolveGet(req.result as T | undefined);
          req.onerror = () => reject(req.error);
        });
      } finally {
        db.close();
      }
    },
    async put(key: string, value: unknown): Promise<void> {
      const db = await openDb();
      try {
        await new Promise<void>((resolvePut, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          if (value === undefined) tx.objectStore(storeName).delete(key);
          else tx.objectStore(storeName).put(value, key);
          tx.oncomplete = () => resolvePut();
          tx.onerror = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    },
  };
}

export function localStorageMirror(): Mirror {
  return {
    get: (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null; // SSR/prerender or storage blocked
      }
    },
    set: (key, value) => {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {
        // best effort
      }
    },
  };
}

export function browserAdapters(): ServiceAdapters {
  const bare = globalThis.fetch.bind(globalThis);
  return {
    fetch: bare,
    kv: idbKeyValue(),
    mirror: localStorageMirror(),
    origin: typeof location !== 'undefined' ? location.origin : '',
    now: () => Date.now(),
  };
}
