import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@zenfs/core';
import { generateBlobKey, isEncryptedBlob } from '../oci/cipher.js';
import { createStorageSession, type StorageSession } from './session.js';
import { createArtifactStorage, type ArtifactStorage } from './artifact-storage.js';
import type { BrowserVaultAdapters, BrowserVaultControl } from './browser-vault.js';
import type { StorageKeyProvider } from './keys.js';

class RawStore extends InMemoryStore {
  writes: Uint8Array[] = [];
  failure: Error | null = null;
  set(id: number, value: Uint8Array): this {
    if (this.failure) throw this.failure;
    this.writes.push(value.slice());
    return super.set(id, value);
  }
  close(): void {}
}

class VaultAdapters implements BrowserVaultAdapters {
  backend = 'indexeddb' as const;
  control: BrowserVaultControl | null = null;
  stores = new Map<string, RawStore>();
  owned = false;
  async readControl() { return this.control && structuredClone(this.control); }
  async writeControl(control: BrowserVaultControl) { this.control = structuredClone(control); }
  async acquireWriter() {
    if (this.owned) throw new Error('Another writer owns the vault');
    this.owned = true;
    return () => { this.owned = false; };
  }
  async generation(id: string, mode: 'open' | 'create') {
    if (mode === 'create') this.stores.set(id, new RawStore());
    return { kind: 'store' as const, store: this.stores.get(id)! };
  }
  async removeGeneration(id: string) { this.stores.delete(id); }
  async legacySources() { return []; }
  async erase() { this.control = null; this.stores.clear(); }
  get store() { return this.stores.get(this.control!.generation!)!; }
}

const sessions: StorageSession[] = [];
const handles: ArtifactStorage[] = [];
const encoded = (value: string) => new TextEncoder().encode(value);
const text = async (source: ReadableStream<Uint8Array>) => new Response(source).text();

async function fixture() {
  let key: CryptoKey | null = await generateBlobKey();
  const originalKey = key;
  const listeners = new Set<() => void>();
  const keys: StorageKeyProvider = {
    storagePolicy: 'encrypted', getKey: () => key,
    requireKey: () => { if (!key) throw new Error('Locked'); return key; },
    suspendForReset: async () => () => { key = null; },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const adapters = new VaultAdapters();
  const session = createStorageSession({ keys, adapters });
  sessions.push(session);
  return { session, adapters, keys,
    lock: () => { key = null; listeners.forEach(listener => listener()); },
    unlock: () => { key = originalKey; listeners.forEach(listener => listener()); },
  };
}

function bound(session: StorageSession, overrides: Partial<Parameters<typeof createArtifactStorage>[0]> = {}) {
  const handle = createArtifactStorage({ session, reference: { artipodId: 'questionnaire-pod', artifactId: 'response-123' }, authorize: () => {}, ...overrides });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.allSettled(handles.splice(0).map(handle => handle.close()));
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
});

describe('protected immutable Artifact storage', () => {
  it('persists bytes and current snapshot under ciphertext and reopens by stable logical identity', async () => {
    const { session, keys, adapters } = await fixture();
    const store = bound(session);
    const attachment = await store.put(encoded('PRIVATE attachment'), { mediaType: 'image/png', filename: 'PRIVATE-name.png' });
    const revision = await store.saveSnapshot(encoded(JSON.stringify({ yjs: 'full state', attachment, subject: 'PRIVATE subject' })), { mediaType: 'application/json' });
    expect(await text(await store.read(attachment))).toBe('PRIVATE attachment');
    expect(adapters.store.writes.every(isEncryptedBlob)).toBe(true);
    expect(adapters.store.writes.every(bytes => !new TextDecoder().decode(bytes).includes('PRIVATE'))).toBe(true);
    await session.close();
    const reopened = createStorageSession({ keys, adapters });
    sessions.push(reopened);
    const restored = bound(reopened);
    const snapshot = await restored.loadSnapshot();
    expect(snapshot?.revision).toBe(revision);
    expect(JSON.parse(await text(snapshot!.source))).toEqual({ yjs: 'full state', attachment, subject: 'PRIVATE subject' });
    expect(await text(await restored.read(attachment))).toBe('PRIVATE attachment');
  });

  it('keeps two Artipods and fifty consumers independent under one session', async () => {
    const { session } = await fixture();
    const consumers = Array.from({ length: 50 }, () => bound(session));
    const other = bound(session, { reference: { artipodId: 'shared-note-pod', artifactId: 'last-visit-note' } });
    const firstRef = await consumers[0].put(encoded('questionnaire'), { mediaType: 'text/plain' });
    const noteRef = await other.put(encoded('shared note'), { mediaType: 'text/plain' });
    await consumers[0].close();
    expect(session.getSnapshot().status).toBe('open');
    expect(await text(await consumers[49].read(firstRef))).toBe('questionnaire');
    expect(await text(await other.read(noteRef))).toBe('shared note');
    await expect(other.read(firstRef)).rejects.toThrow('foreign');
    await expect(consumers[49].read(noteRef)).rejects.toThrow('foreign');
  });

  it('denies access before opening storage or consuming upload bytes', async () => {
    const { session, adapters } = await fixture();
    const authorize = vi.fn(() => { throw new Error('Denied'); });
    const store = bound(session, { authorize });
    const pull = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    await expect(store.put(source, { mediaType: 'image/png' })).rejects.toThrow('Denied');
    expect(pull).not.toHaveBeenCalled();
    expect(adapters.stores.size).toBe(0);
  });

  it('refuses memory-only sessions instead of substituting volatile persistence', async () => {
    const session = createStorageSession({ policy: 'memory' });
    sessions.push(session);
    await expect(bound(session).put(encoded('data'), { mediaType: 'text/plain' })).rejects.toThrow('managed encrypted persistent');
  });

  it('rejects forged encrypted metadata before invoking an untrusted filesystem', async () => {
    const write = vi.fn();
    const session = {
      subscribe: () => () => {}, registerTeardown: (close: () => Promise<void>) => close,
      open: async () => ({ encrypted: true, protection: 'encrypted', memoryOnly: false, zfs: { promises: { writeFile: write } }, assertAccess() {} }),
    } as unknown as StorageSession;
    await expect(bound(session).put(encoded('data'), { mediaType: 'text/plain' })).rejects.toThrow('live core storage context');
    expect(write).not.toHaveBeenCalled();
  });

  it('rejects oversized streamed sources and cancels them before publishing a ref', async () => {
    const { session } = await fixture();
    const store = bound(session, { maxBytes: 5 });
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoded('123')); controller.enqueue(encoded('456')); }, cancel });
    await expect(store.put(source, { mediaType: 'text/plain' })).rejects.toThrow('5-byte');
    expect(cancel).toHaveBeenCalled();
    expect(await store.loadSnapshot()).toBeNull();
  });

  it('revokes active reads on lease loss and permits renewed access without replacing the vault', async () => {
    const { session, lock, unlock } = await fixture();
    const store = bound(session);
    const ref = await store.put(encoded('PRIVATE preview'), { mediaType: 'text/plain' });
    const reader = (await store.read(ref)).getReader();
    lock();
    await expect(reader.read()).rejects.toThrow('locked');
    await expect(store.read(ref)).rejects.toThrow('Locked');
    unlock();
    expect(await text(await store.read(ref))).toBe('PRIVATE preview');
  });

  it('cancels blocked source reads on lock, preserving the previous current snapshot', async () => {
    const { session, lock, unlock } = await fixture();
    const store = bound(session);
    const saved = await store.saveSnapshot(encoded('saved'), { mediaType: 'text/plain' });
    let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; });
    const cancel = vi.fn();
    const uploading = store.saveSnapshot(new ReadableStream<Uint8Array>({ pull() { started(); return new Promise(() => {}); }, cancel }, { highWaterMark: 0 }), { mediaType: 'text/plain' });
    await pending;
    lock();
    await expect(uploading).rejects.toThrow();
    expect(cancel).toHaveBeenCalled();
    unlock();
    expect((await store.loadSnapshot())?.revision).toBe(saved);
  });

  it('rechecks host permission before serving each read chunk and honors cancellation', async () => {
    const { session } = await fixture();
    let denied = false;
    const store = bound(session, { authorize: () => { if (denied) throw new Error('Permission revoked'); } });
    const ref = await store.put(new Uint8Array(100000), { mediaType: 'application/octet-stream' });
    const reader = (await store.read(ref)).getReader();
    expect((await reader.read()).value?.length).toBe(64 * 1024);
    denied = true;
    await expect(reader.read()).rejects.toThrow('Permission revoked');
    denied = false;
    const abort = new AbortController();
    const aborted = (await store.read(ref, { signal: abort.signal })).getReader();
    abort.abort();
    await expect(aborted.read()).rejects.toThrow();
  });

  it('does not report a revision as saved after an encrypted persistence failure', async () => {
    const { session, adapters } = await fixture();
    const store = bound(session);
    await store.saveSnapshot(encoded('saved'), { mediaType: 'text/plain' });
    adapters.store.failure = new Error('Quota exceeded');
    await expect(store.saveSnapshot(encoded('not saved'), { mediaType: 'text/plain' })).rejects.toThrow();
    expect(session.getSnapshot().status).toBe('failed');
  });

  it('serializes concurrent heads from different views and returns a complete saved revision', async () => {
    const { session } = await fixture();
    const first = bound(session);
    const second = bound(session);
    const revisions = await Promise.all([
      first.saveSnapshot(encoded('first'), { mediaType: 'text/plain' }),
      second.saveSnapshot(encoded('second'), { mediaType: 'text/plain' }),
    ]);
    const saved = await first.loadSnapshot();
    expect(revisions).toContain(saved?.revision);
    expect(['first', 'second']).toContain(await text(saved!.source));
  });
});
