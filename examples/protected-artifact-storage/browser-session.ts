/**
 * SYNTHETIC DATA ONLY. This makes local demos reopenable without an auth server.
 * The nonextractable key is structured-cloned into IndexedDB. Any same-origin
 * code can retrieve it: use the authenticated KeysService/broker in production.
 * Serve on a dedicated localhost origin; never reset another vault on failure.
 */
import { createStorageSession, type StorageKeyProvider } from '@artipod/core/storage';

async function demoKey(): Promise<CryptoKey> {
  const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const opening = indexedDB.open('artipod-artifact-synthetic-demo', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('keys');
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => reject(new Error('Close other demo tabs before opening its key store'));
    opening.onsuccess = () => resolve(opening.result);
  });
  try {
    return await new Promise<CryptoKey>((resolve, reject) => {
      const transaction = database.transaction('keys', 'readwrite');
      const store = transaction.objectStore('keys');
      let key: CryptoKey;
      const reading = store.get('root');
      reading.onsuccess = () => {
        key = reading.result ?? candidate;
        if (key?.type !== 'secret' || key.extractable !== false || key.algorithm?.name !== 'AES-GCM') {
          transaction.abort();
          return;
        }
        if (!reading.result) store.put(key, 'root');
      };
      transaction.oncomplete = () => resolve(key);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Invalid synthetic demo key'));
    });
  } finally { database.close(); }
}

export async function createSyntheticArtifactDemoSession() {
  let key: CryptoKey | null = await demoKey();
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(listener => listener());
  const lock = () => { key = null; publish(); };
  const keys: StorageKeyProvider = {
    storagePolicy: 'encrypted',
    getKey: () => key,
    requireKey: () => { if (!key) throw new Error('Synthetic demo is locked'); return key; },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    suspendForReset: async () => lock,
  };
  const session = createStorageSession({ policy: 'protected', keys, backend: 'opfs' });
  await session.open();
  return {
    session,
    lock,
    async unlock() { key = await demoKey(); publish(); await session.open(); },
    async close() { try { await session.close(); } finally { lock(); } },
  };
}
