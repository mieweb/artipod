import { describe, expect, it } from 'vitest';
import { InMemory, InMemoryStore, type FileSystem } from '@zenfs/core';
import { encryptBlob, generateBlobKey, importBlobKey, isEncryptedBlob } from '../oci/cipher.js';
import { openBrowserVault, resetBrowserVault, type BrowserVaultAdapters, type BrowserVaultControl, type BrowserVaultLegacySource } from './browser-vault.js';

const NAME = 'PATIENT-MARKER-Jane-Doe.csv';
const MARKER = 'PII-MARKER,private-row\n';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function put(filesystem: FileSystem, path: string, text: string | Uint8Array): Promise<void> {
  const parts = path.slice(1).split('/');
  let directory = '';
  for (const segment of parts.slice(0, -1)) {
    directory += `/${segment}`;
    if (!(await filesystem.exists(directory))) await filesystem.mkdir(directory, { uid: 0, gid: 0, mode: 0o40755 });
  }
  const bytes = typeof text === 'string' ? encoder.encode(text) : text;
  if (!(await filesystem.exists(path))) await filesystem.createFile(path, { uid: 0, gid: 0, mode: 0o100644 });
  await filesystem.touch(path, { size: 0 });
  await filesystem.write(path, bytes, 0);
  await filesystem.touch(path, { size: bytes.length });
}
async function get(filesystem: FileSystem, path: string): Promise<string> {
  const inode = await filesystem.stat(path);
  const bytes = new Uint8Array(inode.size);
  await filesystem.read(path, bytes, 0, bytes.length);
  return decoder.decode(bytes);
}
class HistoryStore extends InMemoryStore {
  readonly writes: Uint8Array[] = [];
  failAfter = Infinity;
  closes = 0;
  close(): void { this.closes++; }
  set(id: number, bytes: Uint8Array): this {
    if (this.writes.length >= this.failAfter) throw new Error('QuotaExceededError');
    this.writes.push(bytes.slice());
    return super.set(id, bytes);
  }
}
class Harness implements BrowserVaultAdapters {
  backend: 'opfs' | 'indexeddb' = 'opfs';
  control: BrowserVaultControl | null = null;
  readonly controls: BrowserVaultControl[] = [];
  readonly stores = new Map<string, HistoryStore>();
  readonly sources: BrowserVaultLegacySource[] = [];
  readonly removed = new Set<string>();
  locked = false;
  failAfter = Infinity;
  onControl?: (control: BrowserVaultControl) => void;
  onOpen?: (store: HistoryStore) => void;
  failCleanup = false;
  onErase?: () => Promise<void>;
  erased = false;
  async readControl() { return this.control && structuredClone(this.control); }
  async writeControl(control: BrowserVaultControl) {
    this.control = structuredClone(control);
    this.controls.push(structuredClone(control));
    this.onControl?.(control);
  }
  async acquireWriter() {
    if (this.locked) throw new Error('Another writer owns the browser store');
    this.locked = true;
    return () => { this.locked = false; };
  }
  async generation(id: string, mode: 'create' | 'open') {
    if (mode === 'create') {
      expect(this.control?.encryptionRequired).toBe(true);
      expect(this.control?.phase).toBe('copying');
      const store = new HistoryStore();
      store.failAfter = this.failAfter;
      this.stores.set(id, store);
    }
    const store = this.stores.get(id);
    if (!store) throw new Error('Generation missing');
    if (mode === 'open') this.onOpen?.(store);
    return { kind: 'store' as const, store };
  }
  async removeGeneration(id: string) { this.stores.delete(id); }
  async erase() {
    expect(this.locked).toBe(true);
    await this.onErase?.();
    this.stores.clear();
    this.control = null;
    this.erased = true;
  }
  async legacySources() { return this.sources.filter(source => !this.removed.has(source.id)); }
  async addSource(files: Record<string, string | Uint8Array>, id = 'legacy', target = '/') {
    const filesystem = InMemory.create({});
    await filesystem.ready();
    for (const [path, text] of Object.entries(files)) await put(filesystem, path, text);
    const source: BrowserVaultLegacySource = { id, target, filesystem,
      cleanup: async () => {
        if (this.failCleanup) { this.failCleanup = false; throw new Error('Interrupted cleanup'); }
        this.removed.add(id);
      } };
    this.sources.push(source);
    return { source, filesystem };
  }
  assertOnlyCiphertext() {
    for (const store of this.stores.values()) for (const bytes of store.writes) {
      expect(isEncryptedBlob(bytes)).toBe(true);
      expect(decoder.decode(bytes)).not.toContain(NAME);
      expect(decoder.decode(bytes)).not.toContain('PII-MARKER');
    }
    expect(JSON.stringify(this.controls)).not.toContain(NAME);
    expect(JSON.stringify(this.controls)).not.toContain('PII-MARKER');
  }
}

describe('whole-browser encrypted vault', () => {
  it('encrypts the first write, names, scratch data and local metadata; survives reopen', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    await harness.addSource({
      [`/work/blank/${NAME}`]: MARKER,
      '/.artipod/ui-state.json': JSON.stringify({ workspaces: [{ id: NAME }] }),
      '/.artipod/oci/refs/private-ref.json': JSON.stringify({ ref: NAME }),
    });
    const vault = await openBrowserVault({ getKey: () => key, adapters: harness });
    expect(vault.encrypted).toBe(true);
    expect(harness.control?.phase).toBe('ready');
    expect(harness.removed.has('legacy')).toBe(true);
    expect(await get(vault.filesystem, `/work/blank/${NAME}`)).toBe(MARKER);
    await put(vault.filesystem, `/new/${NAME}`, MARKER);
    await vault.flush();
    harness.assertOnlyCiphertext();
    const generation = vault.generation;
    await vault.close();
    const reopened = await openBrowserVault({ getKey: () => key, adapters: harness });
    expect(reopened.generation).toBe(generation);
    expect(await get(reopened.filesystem, `/new/${NAME}`)).toBe(MARKER);
    await reopened.close();
  });

  it('uses encrypted raw blocks for the IndexedDB fallback too', async () => {
    const harness = new Harness();
    harness.backend = 'indexeddb';
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ getKey: () => key, adapters: harness });
    await put(vault.filesystem, `/${NAME}`, MARKER);
    await vault.flush();
    expect(vault.backend).toBe('indexeddb');
    harness.assertOnlyCiphertext();
    await vault.close();
  });

  it('persists the required policy before checking a missing key, with no plaintext fallback', async () => {
    const harness = new Harness();
    await harness.addSource({ [`/${NAME}`]: MARKER });
    await expect(openBrowserVault({ adapters: harness, getKey: () => { throw new Error('Locked'); } })).rejects.toThrow('Locked');
    expect(harness.control?.encryptionRequired).toBe(true);
    expect(harness.control?.phase).toBe('pending');
    expect(harness.stores.size).toBe(0);
    expect(harness.removed.size).toBe(0);
    expect(harness.locked).toBe(false);
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ getKey: () => key, adapters: harness });
    expect(await get(vault.filesystem, `/${NAME}`)).toBe(MARKER);
    await vault.close();
  });

  it('keeps sources intact on quota failure and retries an interrupted copy into a fresh generation', async () => {
    const harness = new Harness();
    harness.failAfter = 8;
    const key = await generateBlobKey();
    await harness.addSource({ [`/${NAME}`]: MARKER });
    // ZenFS may wrap the quota failure in SuppressedError while unwinding a transaction.
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow();
    expect(harness.control?.phase).toBe('copying');
    const incomplete = harness.control?.generation;
    expect(harness.removed.size).toBe(0);
    expect(harness.locked).toBe(false);
    harness.failAfter = Infinity;
    const vault = await openBrowserVault({ getKey: () => key, adapters: harness });
    expect(vault.generation).not.toBe(incomplete);
    expect(harness.stores.has(incomplete!)).toBe(false);
    expect(await get(vault.filesystem, `/${NAME}`)).toBe(MARKER);
    harness.assertOnlyCiphertext();
    await vault.close();
  });

  it('resumes cleanup after a committed pointer, without copying the old tree again', async () => {
    const harness = new Harness();
    harness.failCleanup = true;
    const key = await generateBlobKey();
    await harness.addSource({ [`/${NAME}`]: MARKER });
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow('Interrupted cleanup');
    expect(harness.control?.phase).toBe('cleanup');
    const committed = harness.control?.generation;
    const vault = await openBrowserVault({ getKey: () => key, adapters: harness });
    expect(vault.generation).toBe(committed);
    expect(await get(vault.filesystem, `/${NAME}`)).toBe(MARKER);
    expect(harness.control?.phase).toBe('ready');
    await vault.close();
  });

  it('resumes a source removal interrupted after some entries were deleted', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    const { source, filesystem } = await harness.addSource({ '/a.csv': MARKER, '/b.csv': MARKER });
    let attempts = 0;
    source.cleanup = async () => {
      if (attempts++ === 0) { await filesystem.unlink('/a.csv'); throw new Error('Power interrupted removal'); }
      harness.removed.add(source.id);
    };
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow('Power interrupted removal');
    const vault = await openBrowserVault({ getKey: () => key, adapters: harness });
    expect(await get(vault.filesystem, '/a.csv')).toBe(MARKER);
    expect(await get(vault.filesystem, '/b.csv')).toBe(MARKER);
    await vault.close();
  });

  it('refuses cleanup when a legacy file changed after generation commit', async () => {
    const harness = new Harness();
    harness.failCleanup = true;
    const key = await generateBlobKey();
    const { filesystem } = await harness.addSource({ [`/${NAME}`]: MARKER });
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow('Interrupted cleanup');
    await put(filesystem, `/${NAME}`, 'newer pending changes');
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow('changed after migration');
    expect(harness.removed.size).toBe(0);
    expect(harness.control?.phase).toBe('cleanup');
  });

  it('refuses to ignore a new legacy source that appeared after interrupted cleanup', async () => {
    const harness = new Harness();
    harness.failCleanup = true;
    const key = await generateBlobKey();
    await harness.addSource({ [`/${NAME}`]: MARKER });
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow('Interrupted cleanup');
    await harness.addSource({ '/later.csv': 'new pending edits' }, 'new-database');
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow('New legacy storage appeared');
    expect(harness.removed.size).toBe(0);
    expect(harness.control?.phase).toBe('cleanup');
  });

  it('preserves conflicting source stores rather than overwriting either version', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    await harness.addSource({ [`/${NAME}`]: MARKER }, 'current');
    await harness.addSource({ [`/${NAME}`]: 'different older pending work' }, 'older');
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow('Conflicting legacy');
    expect(harness.removed.size).toBe(0);
    expect(harness.control?.phase).toBe('copying');
  });

  it('accepts retained identical backend copies and keeps the current source metadata', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    const first = await harness.addSource({ [`/work/${NAME}`]: MARKER }, 'current-opfs');
    const second = await harness.addSource({ [`/work/${NAME}`]: MARKER }, 'older-idb');
    await first.filesystem.touch('/work', { mode: 0o40777 });
    await first.filesystem.touch(`/work/${NAME}`, { mtimeMs: 5000, mode: 0o100644 });
    await second.filesystem.touch('/work', { mode: 0o40755 });
    await second.filesystem.touch(`/work/${NAME}`, { mtimeMs: 1000, mode: 0o100600 });
    const vault = await openBrowserVault({ getKey: () => key, adapters: harness });
    const stat = await vault.filesystem.stat(`/work/${NAME}`);
    expect(stat.mtimeMs).toBe(5000);
    expect(stat.mode).toBe(0o100644);
    expect((await vault.filesystem.stat('/work')).mode).toBe(0o40777);
    expect(await get(vault.filesystem, `/work/${NAME}`)).toBe(MARKER);
    expect(harness.removed).toEqual(new Set(['current-opfs', 'older-idb']));
    await vault.close();
  });

  it('preserves already encrypted upper blocks byte-for-byte at their logical upper path', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    const bytes = (await encryptBlob(encoder.encode(MARKER), key)).bytes;
    await harness.addSource({ '/0': bytes }, 'idb-upper', '/.artipod/uppers/opaque-old-ref');
    const vault = await openBrowserVault({ getKey: () => key, adapters: harness });
    const path = '/.artipod/uppers/opaque-old-ref/0';
    const actual = new Uint8Array((await vault.filesystem.stat(path)).size);
    await vault.filesystem.read(path, actual, 0, actual.length);
    expect(actual).toEqual(bytes);
    harness.assertOnlyCiphertext();
    await vault.close();
  });

  it('detects corruption in persisted blocks before deleting any source', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    await harness.addSource({ [`/${NAME}`]: MARKER });
    harness.onOpen = store => {
      const raw = store.get(0)!.slice();
      raw[raw.length - 1] ^= 1;
      store.set(0, raw);
    };
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow();
    expect(harness.removed.size).toBe(0);
    expect(harness.control?.phase).toBe('copying');
    expect(harness.locked).toBe(false);
  });

  it('never replaces a committed generation with an empty one if its root is missing', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ getKey: () => key, adapters: harness });
    await vault.close();
    harness.stores.get(vault.generation)!.delete(0);
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow('missing or corrupt');
    expect(harness.control?.generation).toBe(vault.generation);
    expect(harness.stores.size).toBe(1);
  });

  it('rejects a corrupt bootstrap and a changed backend without creating generations', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    harness.control = { formatVersion: 1, cipher: 'aes-256-gcm-chunked', encryptionRequired: true,
      backend: 'opfs', generation: 'not-an-opaque-generation', phase: 'ready' };
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow('bootstrap is corrupt');
    harness.control.generation = null;
    harness.control.phase = 'pending';
    harness.backend = 'indexeddb';
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow('backend changed');
    expect(harness.stores.size).toBe(0);
  });

  it.each([false, 0, '', undefined, NaN])('rejects a malformed adapter control value (%s) without replacing saved storage', async malformed => {
    const harness = new Harness();
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ getKey: () => key, adapters: harness });
    await put(vault.filesystem, `/${NAME}`, MARKER);
    await vault.close();
    const control = structuredClone(harness.control);
    const controls = structuredClone(harness.controls);
    const saved = harness.stores.get(vault.generation)!;
    const records = [...saved.keys()].map(id => [id, saved.get(id)!.slice()] as const);
    const writes = saved.writes.length;
    harness.readControl = async () => malformed as unknown as BrowserVaultControl;
    await expect(openBrowserVault({ getKey: () => key, adapters: harness }).then(async unexpected => {
      await unexpected.close();
    })).rejects.toThrow('bootstrap is corrupt');
    expect(harness.locked).toBe(false);
    expect(harness.control).toEqual(control);
    expect(harness.controls).toEqual(controls);
    expect([...harness.stores.keys()]).toEqual([vault.generation]);
    expect([...saved.keys()].map(id => [id, saved.get(id)])).toEqual(records);
    expect(saved.writes).toHaveLength(writes);
  });

  it('enforces a single writer and releases ownership on close and failed mount', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ getKey: () => key, adapters: harness });
    await expect(openBrowserVault({ getKey: () => key, adapters: harness })).rejects.toThrow('Another writer');
    await vault.close();
    const wrongKey = await generateBlobKey();
    await expect(openBrowserVault({ getKey: () => wrongKey, adapters: harness })).rejects.toThrow();
    expect(harness.locked).toBe(false);
    const reopened = await openBrowserVault({ getKey: () => key, adapters: harness });
    await reopened.close();
  });

  it('blocks cached access while locked and releases writer ownership even if close cannot flush', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    let locked = false;
    const vault = await openBrowserVault({ adapters: harness, getKey: () => { if (locked) throw new Error('Lease expired'); return key; } });
    await put(vault.filesystem, `/${NAME}`, MARKER);
    await vault.flush();
    const writes = harness.stores.get(vault.generation)!.writes.length;
    locked = true;
    expect(() => vault.filesystem.statSync(`/${NAME}`)).toThrow('Lease expired');
    await expect(vault.flush()).rejects.toThrow('Lease expired');
    await expect(vault.close()).rejects.toThrow('Lease expired');
    expect(harness.locked).toBe(false);
    expect(harness.stores.get(vault.generation)!.writes.length).toBe(writes);
    expect(() => vault.filesystem.statSync(`/${NAME}`)).toThrow('closed');
    const reopened = await openBrowserVault({ getKey: () => key, adapters: harness });
    expect(await get(reopened.filesystem, `/${NAME}`)).toBe(MARKER);
    await reopened.close();
  });

  it('authenticates a renewed CryptoKey object and rejects a different secret before cached access or writes', async () => {
    const harness = new Harness();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    let current = await importBlobKey(secret);
    const vault = await openBrowserVault({ adapters: harness, getKey: () => current });
    await put(vault.filesystem, `/${NAME}`, MARKER);
    await vault.flush();
    current = await importBlobKey(secret);
    await expect(get(vault.filesystem, `/${NAME}`)).rejects.toThrow('key changed');
    await vault.adoptKey();
    expect(await get(vault.filesystem, `/${NAME}`)).toBe(MARKER);
    await put(vault.filesystem, '/renewed.csv', MARKER);
    await vault.flush();
    const validRenewed = current;
    const writes = harness.stores.get(vault.generation)!.writes.length;
    current = await generateBlobKey();
    await expect(vault.adoptKey()).rejects.toThrow();
    await expect(get(vault.filesystem, `/${NAME}`)).rejects.toThrow('key changed');
    await expect(put(vault.filesystem, '/wrong-key.csv', MARKER)).rejects.toThrow('key changed');
    expect(harness.stores.get(vault.generation)!.writes.length).toBe(writes);
    current = validRenewed;
    await vault.close();
    harness.assertOnlyCiphertext();
  });

  it('keeps writer ownership through reset deletion and closes connections before erasing', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ adapters: harness, getKey: () => key });
    const store = harness.stores.get(vault.generation)!;
    let finishErase!: () => void;
    const gate = new Promise<void>(resolve => { finishErase = resolve; });
    let eraseStarted!: () => void;
    const started = new Promise<void>(resolve => { eraseStarted = resolve; });
    harness.onErase = async () => {
      expect(store.closes).toBeGreaterThan(0);
      eraseStarted();
      await gate;
    };
    const resetting = vault.reset();
    await started;
    await expect(openBrowserVault({ adapters: harness, getKey: () => key })).rejects.toThrow('Another writer');
    expect(() => vault.filesystem.statSync('/')).toThrow('closed');
    let closeFinished = false;
    const closing = vault.close().then(() => { closeFinished = true; });
    await Promise.resolve();
    expect(closeFinished).toBe(false);
    finishErase();
    expect(await resetting).toEqual({ warnings: [] });
    await closing;
    expect(harness.erased).toBe(true);
    expect(harness.locked).toBe(false);
  });

  it('continues a confirmed reset after failed persistence and reports the warning', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ adapters: harness, getKey: () => key });
    const store = harness.stores.get(vault.generation)!;
    store.failAfter = store.writes.length;
    await expect(put(vault.filesystem, '/quota.csv', MARKER)).rejects.toThrow();
    const result = await vault.reset();
    expect(result.warnings.join(' ')).toContain('QuotaExceededError');
    expect(harness.erased).toBe(true);
    expect(harness.locked).toBe(false);
  });

  it('drains an already-started operation before erasing and rejects new operations', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ adapters: harness, getKey: () => key });
    await put(vault.filesystem, '/prior.csv', MARKER);
    await vault.flush();
    const filesystem = vault.filesystem;
    const originalRead = Object.getOwnPropertyDescriptor(filesystem, 'read')!.value as FileSystem['read'];
    let finishRead!: () => void;
    let readStarted!: () => void;
    const gate = new Promise<void>(resolve => { finishRead = resolve; });
    const started = new Promise<void>(resolve => { readStarted = resolve; });
    // Capture a VFS read that was accepted before reset began.
    const backing = harness.stores.get(vault.generation)!;
    const originalGet = backing.get.bind(backing);
    // A test hook on the low-level FS method lets the exposed lifecycle proxy
    // observe a pending operation without relying on browser I/O timing.
    Object.defineProperty(filesystem, 'read', { configurable: true, value: async function(this: FileSystem, ...args: Parameters<FileSystem['read']>) {
      readStarted(); await gate;
      // Raw store reads remain available while the accepted call drains.
      expect(originalGet(0)).toBeDefined();
      return Reflect.apply(originalRead, this, args);
    } });
    const read = filesystem.read('/prior.csv', new Uint8Array(MARKER.length), 0, MARKER.length);
    await started;
    const resetting = vault.reset();
    expect(() => filesystem.statSync('/')).toThrow('reset is in progress');
    await Promise.resolve();
    expect(harness.erased).toBe(false);
    finishRead();
    await read;
    await resetting;
    expect(harness.erased).toBe(true);
  });

  it('reports erasure failure and reacquires ownership before a retry', async () => {
    const harness = new Harness();
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ adapters: harness, getKey: () => key });
    harness.onErase = async () => { throw new Error('Deletion failed'); };
    await expect(vault.reset()).rejects.toThrow('Deletion failed');
    expect(harness.control?.encryptionRequired).toBe(true);
    expect(harness.erased).toBe(false);
    expect(harness.locked).toBe(false);
    const other = await openBrowserVault({ adapters: harness, getKey: () => key });
    await expect(vault.reset()).rejects.toThrow('Another writer');
    await other.close();
    harness.onErase = undefined;
    await vault.reset();
    expect(harness.erased).toBe(true);
  });

  it('resets fresh or locked state without opening a generation or needing its key', async () => {
    const harness = new Harness();
    const result = await resetBrowserVault({ adapters: harness });
    expect(result).toEqual({ warnings: [] });
    expect(harness.stores.size).toBe(0);
    expect(harness.erased).toBe(true);
    expect(harness.locked).toBe(false);
  });
});
