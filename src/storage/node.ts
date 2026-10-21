/**
 * Native encrypted-storage backing. Import from `@artipod/core/storage/node`;
 * this module is deliberately absent from the browser storage entry point.
 *
 * Workspace bytes are encrypted by StorageSession before reaching this raw
 * numeric store. It is not a plaintext filesystem mount for native programs.
 */
import * as fs from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AsyncMap, Store, Transaction } from '@zenfs/core';
import type { BrowserVaultAdapters, BrowserVaultControl } from './browser-vault.js';

export interface NativeStorageOptions {
  /** Observe every raw write before it is issued, including control/lock files. */
  onWrite?: (path: string, bytes: Uint8Array) => void | Promise<void>;
}

const CONTROL = 'control.json';
const GENERATIONS = 'generations';
const LOCK = '.writer.lock';
const TEMP = /^\.atomic-[a-f0-9]{32}$/;
const token = () => randomUUID().replace(/-/g, '');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const validGeneration = (id: string) => {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid native storage generation');
};
const recordName = (id: number) => {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid native storage record');
  return String(id);
};

/** fsync the containing directory as well as each replacement's data file. */
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function requireDirectory(path: string): Promise<void> {
  const info = await fs.lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Native storage requires real directories');
}

interface NativeLock { formatVersion: 1; pid: number; token: string }
function parseLock(bytes: string): NativeLock {
  const value = JSON.parse(bytes) as NativeLock;
  if (value.formatVersion !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || !/^[a-f0-9]{32}$/.test(value.token)) {
    throw new Error('Invalid native storage writer lock; refusing to replace it');
  }
  return value;
}

/**
 * A local directory exclusively owned by this adapter. Atomic same-directory
 * replacements and file/directory fsync must be supported by the filesystem.
 * Network filesystems and cross-host writer coordination are unsupported.
 *
 * Locks left by a dead process fail closed. Portable Node has no atomic
 * compare-and-unlink primitive: automatically stealing a stale lock could
 * remove a replacement writer's lock. An operator may remove `.writer.lock`
 * only after checking that no process owns this private directory.
 */
export async function createNativeStorageAdapters(directory: string, options: NativeStorageOptions = {}): Promise<BrowserVaultAdapters> {
  const root = resolve(directory);
  const firstCreated = await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await requireDirectory(root);
  // Persist newly created directory links too, including any parents made by
  // recursive mkdir. Later block/control commits sync their own directories.
  if (firstCreated) for (let created = root; ; created = dirname(created)) {
    await syncDirectory(dirname(created));
    if (created === firstCreated) break;
  }
  const generations = join(root, GENERATIONS);
  const lockPath = join(root, LOCK);
  let ownedToken: string | null = null;
  const assertOwned = () => {
    if (!ownedToken) throw new Error('Native storage writer ownership is required');
    const current = parseLock(readFileSync(lockPath, 'utf8'));
    if (current.token !== ownedToken || current.pid !== process.pid) throw new Error('Native storage writer ownership changed');
  };
  const observe = async (path: string, bytes: Uint8Array) => { await options.onWrite?.(path, bytes.slice()); };
  const atomicWrite = async (parent: string, name: string, bytes: Uint8Array): Promise<void> => {
    assertOwned();
    await requireDirectory(parent);
    const temporary = join(parent, `.atomic-${token()}`);
    let handle: fs.FileHandle | undefined;
    try {
      await observe(temporary, bytes);
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      assertOwned();
      await fs.rename(temporary, join(parent, name));
      await syncDirectory(parent);
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch(error => { if (!missing(error)) throw error; });
    }
  };
  const cleanTemporaries = async (parent: string): Promise<void> => {
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      if (TEMP.test(entry.name)) {
        if (!entry.isFile()) throw new Error('Invalid native storage temporary record');
        await fs.unlink(join(parent, entry.name));
      }
    }
  };

  return {
    backend: 'native',
    async acquireWriter() {
      if (ownedToken) throw new Error('Another writer already owns this native storage adapter');
      const identity: NativeLock = { formatVersion: 1, pid: process.pid, token: token() };
      const bytes = new TextEncoder().encode(JSON.stringify(identity));
      let handle: fs.FileHandle;
      try { handle = await fs.open(lockPath, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let existing: NativeLock;
        try {
          const info = await fs.lstat(lockPath);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid lock file', { cause: error });
          existing = parseLock(await fs.readFile(lockPath, 'utf8'));
        } catch (failure) {
          throw new Error('Native storage writer lock is unreadable or incomplete; refusing to replace it', { cause: failure });
        }
        try { process.kill(existing.pid, 0); }
        catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === 'ESRCH') {
            throw new Error('Native storage has a stale writer lock from a dead process; verify no writer remains before removing .writer.lock', { cause: failure });
          }
        }
        throw new Error('Another process owns the native storage writer lock', { cause: error });
      }
      ownedToken = identity.token;
      try {
        await observe(lockPath, bytes);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        await syncDirectory(root);
        await cleanTemporaries(root);
      } catch (error) {
        await handle.close().catch(() => {});
        // We created this lock and have not returned ownership to a caller.
        await fs.unlink(lockPath).catch(() => {});
        ownedToken = null;
        throw error;
      }
      let released = false;
      return () => {
        if (released) return;
        assertOwned();
        unlinkSync(lockPath);
        ownedToken = null;
        released = true;
      };
    },
    async readControl() {
      // Policy preflight is read-only and may run before key acquisition or
      // writer ownership. Atomic replacement prevents partial JSON reads.
      const entries = await fs.readdir(root);
      if (entries.some(name => ![CONTROL, GENERATIONS, LOCK].includes(name) && !TEMP.test(name))) {
        throw new Error('Native storage directory contains unrecognized files; refusing an empty replacement');
      }
      try {
        const path = join(root, CONTROL);
        const info = await fs.lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid native storage control file');
        return JSON.parse(await fs.readFile(path, 'utf8')) as BrowserVaultControl;
      } catch (error) {
        if (!missing(error)) throw error;
        try {
          await requireDirectory(generations);
          if ((await fs.readdir(generations)).length) throw new Error('Native encrypted generations exist without their bootstrap; refusing an empty replacement', { cause: error });
        } catch (failure) { if (!missing(failure)) throw failure; }
        return null;
      }
    },
    async writeControl(control) {
      await atomicWrite(root, CONTROL, new TextEncoder().encode(JSON.stringify(control)));
    },
    async generation(id, mode) {
      assertOwned();
      validGeneration(id);
      if (mode === 'create') {
        await fs.mkdir(generations, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        await requireDirectory(generations);
        await fs.mkdir(join(generations, id), { mode: 0o700 });
        await syncDirectory(generations);
        await syncDirectory(root);
      }
      await requireDirectory(generations);
      const parent = join(generations, id);
      await requireDirectory(parent);
      await cleanTemporaries(parent);
      const ids = new Set<number>();
      for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
        if (!entry.isFile() || !/^(0|[1-9]\d*)$/.test(entry.name) || recordName(Number(entry.name)) !== entry.name) {
          throw new Error('Invalid native storage backing record');
        }
        ids.add(Number(entry.name));
      }
      const { AsyncMapTransaction } = await import('@zenfs/core');
      let closed = false;
      const assertOpen = () => { assertOwned(); if (closed) throw new Error('Native storage backing is closed'); };
      const store: Store & AsyncMap & { close(): void } = {
        name: 'native-storage', flags: [],
        keys() { assertOpen(); return ids; },
        cached: () => undefined,
        async get(id) {
          assertOpen();
          const path = join(parent, recordName(id));
          try {
            const info = await fs.lstat(path);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid native storage backing record');
            return new Uint8Array(await fs.readFile(path));
          } catch (error) { if (missing(error)) return undefined; throw error; }
        },
        async set(id, data, offset = 0) {
          assertOpen();
          let bytes = data.slice();
          if (offset !== 0) {
            if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid native storage record offset');
            const previous = await store.get(id) ?? new Uint8Array();
            bytes = new Uint8Array(Math.max(previous.length, offset + data.length));
            bytes.set(previous);
            bytes.set(data, offset);
          }
          await atomicWrite(parent, recordName(id), bytes);
          ids.add(id);
        },
        async delete(id) {
          assertOpen();
          await fs.unlink(join(parent, recordName(id))).catch(error => { if (!missing(error)) throw error; });
          ids.delete(id);
          await syncDirectory(parent);
        },
        async sync() { assertOpen(); },
        transaction(): Transaction { assertOpen(); return new AsyncMapTransaction(store); },
        close() { closed = true; },
      };
      return { kind: 'store', store };
    },
    async removeGeneration(id) {
      assertOwned();
      validGeneration(id);
      try { await requireDirectory(generations); }
      catch (error) { if (missing(error)) return; throw error; }
      await fs.rm(join(generations, id), { recursive: true, force: true });
      await syncDirectory(generations);
    },
    async legacySources() { assertOwned(); return []; },
    async erase() {
      assertOwned();
      // Only this adapter's private namespace is erased; ownership is released
      // by the session after the awaited terminal deletion and durability sync.
      await fs.rm(generations, { recursive: true, force: true });
      await fs.unlink(join(root, CONTROL)).catch(error => { if (!missing(error)) throw error; });
      await cleanTemporaries(root);
      await syncDirectory(root);
    },
  };
}
