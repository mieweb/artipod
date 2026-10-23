import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsyncMap } from '@zenfs/core';
import { encryptBlob, generateBlobKey, isEncryptedBlob } from '../oci/cipher.js';
import { encryptedStoreMount, type EncryptedStoreFileSystem } from './encrypted-store.js';
import { openBrowserVault, type BrowserVaultAdapters } from './browser-vault.js';
import { createStorageSession } from './session.js';

const STAGE = /^\.artipod-stage-v1-(0|[1-9]\d*)-[a-f0-9]{32}$/;
const stage = (id: number, nonce = 'a') => `.artipod-stage-v1-${id}-${nonce.repeat(32)}`;
const encode = (text: string) => new TextEncoder().encode(text);
type Phase = 'create' | 'write' | 'close';

/** Models OPFS close and move publication, plus abrupt-context snapshots. */
class OpfsDirectory {
  readonly files = new Map<string, Uint8Array>();
  readonly writes: { name: string; bytes: Uint8Array }[] = [];
  readonly creates: string[] = [];
  gate?: { phase: Phase; entered: (name: string) => void; wait: Promise<void> };
  failure?: 'createWritable' | 'write' | 'close' | 'move';
  cleanupError?: Error;
  aborts = 0;

  async *keys() { yield* this.files.keys(); }

  async pause(phase: Phase, name: string): Promise<void> {
    if (this.gate?.phase !== phase) return;
    this.gate.entered(name);
    await this.gate.wait;
  }

  fail(operation: string): void {
    if (this.failure === operation) throw new Error(`${operation} failed`);
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (!options?.create) throw new DOMException('missing', 'NotFoundError');
      this.files.set(name, new Uint8Array());
      this.creates.push(name);
      await this.pause('create', name);
    }
    return {
      getFile: async () => ({ arrayBuffer: async () => this.files.get(name)!.slice().buffer }),
      createWritable: async () => {
        this.fail('createWritable');
        let pending = new Uint8Array();
        return {
          write: async (bytes: Uint8Array) => {
            this.fail('write');
            pending = bytes.slice();
            this.writes.push({ name, bytes: pending.slice() });
            await this.pause('write', name);
          },
          close: async () => {
            this.fail('close');
            this.files.set(name, pending);
            await this.pause('close', name);
          },
          abort: async () => { this.aborts++; },
        };
      },
      move: async (_destination: FileSystemDirectoryHandle, nextName: string) => {
        this.fail('move');
        // One atomic replacement, including when nextName already exists.
        this.files.set(nextName, this.files.get(name)!);
        this.files.delete(name);
      },
    };
  }

  async removeEntry(name: string): Promise<void> {
    if (this.cleanupError) throw this.cleanupError;
    this.files.delete(name);
  }

  copy(): OpfsDirectory {
    const next = new OpfsDirectory();
    for (const [name, bytes] of this.files) next.files.set(name, bytes.slice());
    return next;
  }

  get handle() { return this as unknown as FileSystemDirectoryHandle; }
}

function store(fs: EncryptedStoreFileSystem): AsyncMap {
  return (fs as unknown as { store: AsyncMap }).store;
}

async function open(dir: OpfsDirectory, key: CryptoKey): Promise<EncryptedStoreFileSystem> {
  return encryptedStoreMount({ backing: { kind: 'opfs', dir: dir.handle }, getKey: () => key, strictCiphertext: true });
}

async function saved() {
  const key = await generateBlobKey();
  const dir = new OpfsDirectory();
  const fs = await open(dir, key);
  await store(fs).set(129129, encode('last saved record'));
  await fs.flush();
  return { key, dir, fs };
}

function adaptersFor(dir: OpfsDirectory): BrowserVaultAdapters {
  let owned = false;
  return {
    backend: 'opfs',
    async acquireWriter() {
      if (owned) throw new Error('Another writer owns storage');
      owned = true;
      return () => { owned = false; };
    },
    async readControl() {
      return { formatVersion: 1, cipher: 'aes-256-gcm-chunked', encryptionRequired: true,
        backend: 'opfs', generation: '1'.repeat(32), phase: 'ready' };
    },
    async writeControl() { throw new Error('Unexpected bootstrap write'); },
    async generation() { return { kind: 'opfs', dir: dir.handle }; },
    async removeGeneration() { throw new Error('Unexpected generation removal'); },
    async legacySources() { return []; },
    async erase() { dir.files.clear(); },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('OPFS ciphertext publication and interruption recovery', () => {
  it('reproduces the former empty-numeric-record failure without treating it as recoverable', async () => {
    const { key, dir } = await saved();
    await dir.getFileHandle('131313', { create: true });
    const before = dir.copy().files;
    // These are the only diagnostics needed for this failure; never log data.
    const diagnostics = [...dir.files].map(([id, bytes]) => ({ id, length: bytes.length, envelope: isEncryptedBlob(bytes) }));
    expect(diagnostics).toContainEqual({ id: '131313', length: 0, envelope: false });
    await expect(open(dir, key)).rejects.toThrow('plaintext backing block refused');
    expect(dir.files).toEqual(before);
  });

  it.each(['create', 'write', 'close'] as const)('keeps canonical records unchanged when interrupted after stage %s', async (phase) => {
    const { key, dir, fs } = await saved();
    const canonical = dir.copy().files;
    let release!: () => void;
    let entered!: (name: string) => void;
    const started = new Promise<string>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    dir.gate = { phase, entered, wait };
    const pending = store(fs).set(131313, encode('interrupted record'));
    const name = await started;
    expect(name).toMatch(STAGE);
    const interrupted = dir.copy(); // navigation destroys the in-flight context
    expect(new Map([...interrupted.files].filter(([id]) => !STAGE.test(id)))).toEqual(canonical);
    const raw = interrupted.files.get(name)!;
    expect({ length: raw.length, envelope: isEncryptedBlob(raw) }).toEqual(phase === 'close'
      ? { length: raw.length, envelope: true } : { length: 0, envelope: false });
    try {
      const reopened = await open(interrupted, key);
      expect(await store(reopened).get(129129)).toEqual(encode('last saved record'));
      expect(await store(reopened).get(131313)).toBeUndefined();
      expect(interrupted.files).toEqual(canonical);
    } finally {
      release();
      await pending;
    }
    expect(dir.creates.every(id => STAGE.test(id))).toBe(true);
    expect(dir.writes.every(({ bytes }) => isEncryptedBlob(bytes))).toBe(true);
  });

  it.each(['createWritable', 'write', 'close', 'move'] as const)('preserves saved ciphertext on a caught %s failure', async (operation) => {
    const { key, dir, fs } = await saved();
    const before = dir.copy().files;
    dir.failure = operation;
    await expect(store(fs).set(129129, encode('replacement'))).rejects.toThrow(`${operation} failed`);
    await expect(fs.flush()).rejects.toThrow(`${operation} failed`);
    expect(dir.files).toEqual(before);
    const reopened = await open(dir.copy(), key);
    expect(await store(reopened).get(129129)).toEqual(encode('last saved record'));
  });

  it('replaces a saved record only with a completely closed ciphertext stage', async () => {
    const { key, dir, fs } = await saved();
    await store(fs).set(129129, encode('saved replacement'));
    await fs.flush();
    expect([...dir.files.keys()].every(id => /^(0|[1-9]\d*)$/.test(id))).toBe(true);
    expect(dir.writes.every(({ name, bytes }) => STAGE.test(name) && isEncryptedBlob(bytes))).toBe(true);
    const reopened = await open(dir, key);
    expect(await store(reopened).get(129129)).toEqual(encode('saved replacement'));
  });

  it('discards authenticated abandoned stages without replaying them over saved records', async () => {
    const { key, dir } = await saved();
    const before = dir.copy().files;
    dir.files.set(stage(129129), (await encryptBlob(encode('unpublished replacement'), key)).bytes);
    dir.files.set(stage(131313, 'b'), new Uint8Array());
    const reopened = await open(dir, key);
    expect(await store(reopened).get(129129)).toEqual(encode('last saved record'));
    expect(reopened.recoveredStages).toBe(2);
    expect(dir.files).toEqual(before);
    expect((await open(dir, key)).recoveredStages).toBe(0);
  });

  it('reports discarded stages through public vault and session APIs without poisoning a successful flush', async () => {
    const { key, dir } = await saved();
    const adapters = adaptersFor(dir);
    dir.files.set(stage(131313), new Uint8Array());
    const vault = await openBrowserVault({ adapters, getKey: () => key });
    try {
      expect(vault.filesystem.recoveredStages).toBe(1);
      expect(vault.recoveryWarning).toContain('Some pending changes may not have been saved');
      await expect(vault.flush()).resolves.toBeUndefined();
    } finally { await vault.close(); }

    dir.files.set(stage(141414), new Uint8Array());
    const session = createStorageSession({ adapters, keys: {
      getKey: () => key, requireKey: () => key, storagePolicy: 'encrypted',
      async suspendForReset() { return () => {}; },
    } });
    try {
      const info = await session.open();
      expect(info.recoveryWarning).toContain('Some pending changes may not have been saved');
      expect(session.needsRecovery()).toBe(false);
      await expect(info.flush()).resolves.toBeUndefined();
    } finally { await session.close(); }

    const clean = await openBrowserVault({ adapters, getKey: () => key });
    try { expect(clean.recoveryWarning).toBeUndefined(); }
    finally { await clean.close(); }
  });

  it.each(['plaintext', 'truncated', 'tampered', 'missing-chunks'] as const)('rejects a %s stage and preserves every original entry', async (kind) => {
    const { key, dir } = await saved();
    let raw = (await encryptBlob(encode('unpublished'), key)).bytes;
    if (kind === 'plaintext') raw = encode('actual plaintext');
    if (kind === 'truncated') raw = raw.slice(0, -1);
    if (kind === 'tampered') raw[raw.length - 1] ^= 1;
    if (kind === 'missing-chunks') {
      const header = encode(JSON.stringify({ formatVersion: 1, cipher: 'aes-256-gcm', chunkSize: 4096, plaintextSize: 0, nonces: [] }));
      raw = new Uint8Array(12 + header.length);
      raw.set(encode('APODENC1'));
      new DataView(raw.buffer).setUint32(8, header.length, false);
      raw.set(header, 12);
    }
    dir.files.set(stage(131313), new Uint8Array());
    dir.files.set(stage(141414, 'b'), raw);
    const before = dir.copy().files;
    await expect(open(dir, key)).rejects.toThrow();
    expect(dir.files).toEqual(before);
  });

  it.each(['empty', 'tampered'] as const)('validates %s canonical records before removing any stages', async (kind) => {
    const { key, dir } = await saved();
    if (kind === 'empty') dir.files.set('131313', new Uint8Array());
    else dir.files.get('129129')![dir.files.get('129129')!.length - 1] ^= 1;
    dir.files.set(stage(131313), new Uint8Array());
    const before = dir.copy().files;
    await expect(open(dir, key)).rejects.toThrow();
    expect(dir.files).toEqual(before);
  });

  it.each([
    '.artipod-stage-v1-01-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '.artipod-stage-v1-1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    '.artipod-stage-v1-9007199254740992-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '.artipod-stage-v1-1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-extra',
    'private-name.txt',
  ])('rejects unknown reserved-looking entry %s without cleanup', async (name) => {
    const { key, dir } = await saved();
    dir.files.set(name, new Uint8Array());
    dir.files.set(stage(131313), new Uint8Array());
    const before = dir.copy().files;
    await expect(open(dir, key)).rejects.toThrow('unexpected plaintext backing entry refused');
    expect(dir.files).toEqual(before);
  });

  it('does not delete authenticated stages when the current key cannot authenticate them', async () => {
    const { key, dir } = await saved();
    const wrongKey = await generateBlobKey();
    dir.files.set(stage(131313), (await encryptBlob(encode('unpublished'), wrongKey)).bytes);
    const before = dir.copy().files;
    await expect(open(dir, key)).rejects.toThrow('authentication');
    expect(dir.files).toEqual(before);
  });

  it('reports abandoned-stage cleanup failures while preserving canonical ciphertext', async () => {
    const { key, dir } = await saved();
    dir.files.set(stage(131313), new Uint8Array());
    dir.cleanupError = new DOMException('cleanup denied', 'NotAllowedError');
    const before = dir.copy().files;
    await expect(open(dir, key)).rejects.toThrow('cleanup denied');
    expect(dir.files).toEqual(before);
  });

  it('retains the initiating write failure when stage removal also fails, then reports recovery on reopen', async () => {
    const { key, dir, fs } = await saved();
    const canonical = dir.copy().files;
    dir.failure = 'write';
    dir.cleanupError = new Error('cleanup also failed');
    await expect(store(fs).set(129129, encode('replacement'))).rejects.toThrow('write failed');
    await expect(fs.flush()).rejects.toThrow('write failed');
    expect(new Map([...dir.files].filter(([name]) => !STAGE.test(name)))).toEqual(canonical);
    const interrupted = dir.copy();
    const reopened = await open(interrupted, key);
    expect(reopened.recoveredStages).toBe(1);
    expect(interrupted.files).toEqual(canonical);
  });

  it('requires native atomic move before creating any OPFS entries', async () => {
    vi.stubGlobal('FileSystemFileHandle', { prototype: {} });
    const dir = new OpfsDirectory();
    await expect(open(dir, await generateBlobKey())).rejects.toThrow('requires atomic FileSystemFileHandle.move()');
    expect(dir.files.size).toBe(0);
    expect(dir.creates).toEqual([]);
    expect(dir.writes).toEqual([]);
  });
});
