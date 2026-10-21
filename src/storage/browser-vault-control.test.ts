import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserVaultRequired, createBrowserVaultAdapters, type BrowserVaultControl } from './browser-vault.js';

// Only the bootstrap reader's IDB boundary is simulated here; full backing
// encryption and browser persistence are exercised by the consumer harness.
function controlDatabase(present: boolean, value?: unknown) {
  function request<T>(result: T) {
    const operation = { result, onsuccess: undefined as (() => void) | undefined };
    queueMicrotask(() => operation.onsuccess?.());
    return operation;
  }
  const store = {
    get: vi.fn(() => request(value)),
    count: vi.fn(() => request(present ? 1 : 0)),
  };
  const db = {
    objectStoreNames: { contains: (name: string) => name === 'control' },
    transaction: vi.fn((_name: string, mode: string) => {
      expect(mode).toBe('readonly');
      const transaction = { objectStore: () => store, oncomplete: undefined as (() => void) | undefined };
      setTimeout(() => transaction.oncomplete?.(), 0);
      return transaction;
    }),
    close: vi.fn(),
  };
  vi.stubGlobal('navigator', undefined);
  vi.stubGlobal('indexedDB', {
    open: vi.fn(() => request(db)),
    databases: async () => [{ name: 'artipod-vault-control' }],
  });
  return { db };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('browser vault bootstrap presence', () => {
  it.each([undefined, null, false, 0, ''])('rejects a present malformed record (%s) during policy preflight and adapter creation', async value => {
    const { db } = controlDatabase(true, value);
    await expect(browserVaultRequired()).rejects.toThrow('bootstrap is corrupt');
    await expect(createBrowserVaultAdapters('indexeddb')).rejects.toThrow('bootstrap is corrupt');
    expect(db.close).toHaveBeenCalledTimes(2);
  });

  it('allows a definitively absent record in an existing control database', async () => {
    controlDatabase(false);
    expect(await browserVaultRequired()).toBe(false);
    const adapters = await createBrowserVaultAdapters('indexeddb');
    expect(await adapters.readControl()).toBeNull();
    expect(adapters.backend).toBe('indexeddb');
  });

  it('retains a supported saved control record', async () => {
    const control: BrowserVaultControl = { formatVersion: 1, cipher: 'aes-256-gcm-chunked', encryptionRequired: true,
      backend: 'indexeddb', generation: 'a'.repeat(32), phase: 'ready' };
    controlDatabase(true, control);
    expect(await browserVaultRequired()).toBe(true);
    const adapters = await createBrowserVaultAdapters();
    expect(await adapters.readControl()).toEqual(control);
    expect(adapters.backend).toBe('indexeddb');
  });
});
