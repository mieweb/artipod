#!/usr/bin/env node
/**
 * Actual-browser regression for the vault's raw OPFS/IndexedDB adapters.
 * Creates its own disposable localhost server and browser contexts. Legacy
 * fixtures contain synthetic markers only. No application server is needed.
 * PLAYWRIGHT_MODULE_PATH and CHROMIUM_EXECUTABLE_PATH follow the SPA harness.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { build } = require(resolve(root, 'node_modules/esbuild'));
let playwright;
try { playwright = process.env.PLAYWRIGHT_MODULE_PATH ? require(resolve(process.env.PLAYWRIGHT_MODULE_PATH)) : require('playwright'); }
catch (error) {
  if (!process.env.PLAYWRIGHT_MODULE_PATH) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE_PATH', { cause: error });
  playwright = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
}
const bundle = await build({ stdin: { resolveDir: root, contents: `
  import * as zen from '@zenfs/core';
  import {openBrowserVault,createBrowserVaultAdapters,browserVaultRequired,resetBrowserVault} from './src/sandbox/browser-vault.ts';
  import {encryptedStoreMount} from './src/sandbox/encrypted-store.ts';
  import {importBlobKey,encryptBlob,isEncryptedBlob} from './src/oci/cipher.ts';
  globalThis.vaultApi={zen,openBrowserVault,createBrowserVaultAdapters,browserVaultRequired,resetBrowserVault,encryptedStoreMount,importBlobKey,encryptBlob,isEncryptedBlob};
` }, bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022' });
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', request.url === '/vault.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/vault.js' ? bundle.outputFiles[0].contents : '<!doctype html><script src="/vault.js"></script>');
});
await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
const url = `http://127.0.0.1:${server.address().port}`;
const marker = `private-vault-probe-${randomUUID()}`;
let browser;
const reports = [];

async function installHelpers(page) {
  await page.goto(url);
  await page.waitForFunction(() => !!window.vaultApi);
  await page.evaluate(async marker => {
    const api = window.vaultApi;
    window.marker = marker;
    window.secret = new Uint8Array(32).fill(7);
    window.key = await api.importBlobKey(window.secret);
    window.writeLogical = async (filesystem, path, input) => {
      const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
      let parent = '';
      for (const part of path.slice(1).split('/').slice(0, -1)) {
        parent += `/${part}`;
        if (!(await filesystem.exists(parent))) await filesystem.mkdir(parent, { uid: 0, gid: 0, mode: 0o40755 });
      }
      if (!(await filesystem.exists(path))) await filesystem.createFile(path, { uid: 0, gid: 0, mode: 0o100644 });
      await filesystem.touch(path, { size: 0 });
      if (bytes.length) await filesystem.write(path, bytes, 0);
      await filesystem.touch(path, { size: bytes.length });
    };
    window.readLogical = async (filesystem, path) => {
      const bytes = new Uint8Array((await filesystem.stat(path)).size);
      await filesystem.read(path, bytes, 0, bytes.length);
      return new TextDecoder().decode(bytes);
    };
    window.writeRawFile = async (root, path, input) => {
      let dir = root;
      const parts = path.split('/').filter(Boolean);
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const handle = await dir.getFileHandle(parts.at(-1), { create: true });
      const writable = await handle.createWritable();
      await writable.write(input);
      await writable.close();
    };
    window.writeOldDatabase = async (name, records) => {
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open(name, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(name);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(name, 'readwrite');
          for (const [id, value] of records) tx.objectStore(name).put(value, id);
          tx.oncomplete = resolve;
          tx.onabort = tx.onerror = () => reject(tx.error);
        });
      } finally { db.close(); }
    };
    window.legacyUpper = async () => {
      const store = new api.zen.InMemoryStore();
      const filesystem = await api.encryptedStoreMount({ backing: { kind: 'store', store }, getKey: () => window.key });
      await window.writeLogical(filesystem, `/${marker}-pending.csv`, `${marker}-pending-body`);
      await filesystem.flush();
      return store;
    };
    window.beginObserver = () => {
      window.writeViolations = [];
      const inspect = value => {
        if (typeof value === 'string') {
          if (value.includes(marker) || value.includes(encodeURIComponent(marker))) window.writeViolations.push(value);
        } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
          const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          inspect(new TextDecoder().decode(bytes));
        } else if (value && typeof value === 'object' && !(value instanceof CryptoKey)) {
          for (const [key, item] of Object.entries(value)) { inspect(key); inspect(item); }
        }
      };
      for (const method of ['put', 'add']) {
        const original = IDBObjectStore.prototype[method];
        IDBObjectStore.prototype[method] = function(value, key) { inspect(value); inspect(key); return original.apply(this, arguments); };
      }
      const write = FileSystemWritableFileStream.prototype.write;
      FileSystemWritableFileStream.prototype.write = function(value) { inspect(value); return write.apply(this, arguments); };
      for (const method of ['getFileHandle', 'getDirectoryHandle']) {
        const original = FileSystemDirectoryHandle.prototype[method];
        FileSystemDirectoryHandle.prototype[method] = function(name, options) { if (options?.create) inspect(name); return original.apply(this, arguments); };
      }
    };
    window.scanRaw = async () => {
      const violations = [];
      const check = value => {
        if (typeof value === 'string') { if (value.includes(marker)) violations.push(value); }
        else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
          const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          check(new TextDecoder().decode(bytes));
        } else if (value && typeof value === 'object' && !(value instanceof CryptoKey)) for (const [key, item] of Object.entries(value)) { check(key); check(item); }
      };
      const opfs = await navigator.storage.getDirectory();
      const walk = async (dir, path = '') => {
        for await (const [name, handle] of dir.entries()) {
          check(name);
          if (handle.kind === 'directory') await walk(handle, `${path}/${name}`);
          else {
            const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
            check(bytes);
            if (path.startsWith('/artipod-vault/')) {
              if (!/^\d+$/.test(name) || !api.isEncryptedBlob(bytes)) throw new Error('OPFS generation contains a non-ciphertext block');
            }
          }
        }
      };
      await walk(opfs);
      const databases = await indexedDB.databases();
      for (const { name } of databases) {
        check(name);
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
        try {
          for (const storeName of db.objectStoreNames) {
            check(storeName);
            const values = await new Promise((resolve, reject) => {
              const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
              request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
            });
            for (const value of values) {
              check(value);
              if (name.startsWith('artipod-vault-blocks-') && !api.isEncryptedBlob(new Uint8Array(value))) throw new Error('IDB generation contains a non-ciphertext block');
            }
          }
        } finally { db.close(); }
      }
      return { violations, writes: window.writeViolations, databases: databases.map(({ name }) => name) };
    };
  }, marker);
}

try {
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  {
    const context = await browser.newContext();
    const owner = await context.newPage();
    await installHelpers(owner);
    const generation = await owner.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      await window.writeRawFile(root, 'artipod-models/public-model.bin', 'public reset-safe asset');
      window.vault = await window.vaultApi.openBrowserVault({ getKey: () => window.key, backend: 'indexeddb' });
      await window.writeLogical(window.vault.filesystem, '/before-reset.csv', window.marker);
      await window.vault.flush();
      window.resetDone = false;
      window.blockedDeletion = false;
      const remove = indexedDB.deleteDatabase;
      indexedDB.deleteDatabase = function(name) {
        const request = remove.call(this, name);
        request.addEventListener('blocked', () => { window.blockedDeletion = true; });
        return request;
      };
      return window.vault.generation;
    });
    const blocker = await context.newPage();
    await installHelpers(blocker);
    await blocker.evaluate(async generation => {
      window.heldDatabase = await new Promise((resolve, reject) => {
        const request = indexedDB.open(`artipod-vault-blocks-${generation}`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }, generation);
    await owner.evaluate(() => {
      window.resetTask = window.vault.reset().then(result => { window.resetResult = result; window.resetDone = true; });
    });
    await owner.waitForFunction(() => window.blockedDeletion);
    assert.equal(await owner.evaluate(() => window.resetDone), false, 'blocked deletion is not a completed reset');
    assert.equal(await owner.evaluate(() => window.vaultApi.browserVaultRequired()), true, 'bootstrap must remain until backing deletion completes');
    const denied = await blocker.evaluate(async () => {
      try { await window.vaultApi.openBrowserVault({ getKey: () => window.key }); return false; }
      catch (error) { return error.message.includes('another tab'); }
    });
    assert.equal(denied, true, 'reset must retain writer ownership while IDB deletion is blocked');
    await blocker.evaluate(() => window.heldDatabase.close());
    await owner.waitForFunction(() => window.resetDone);
    const erased = await owner.evaluate(async () => ({
      result: window.resetResult,
      required: await window.vaultApi.browserVaultRequired(),
      databases: (await indexedDB.databases()).map(db => db.name),
      model: await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('artipod-models')).getFileHandle('public-model.bin')).getFile().then(file => file.text()),
    }));
    assert.deepEqual(erased.result, { warnings: [] });
    assert.equal(erased.required, false);
    assert.equal(erased.databases.some(name => name.startsWith('artipod')), false);
    assert.equal(erased.model, 'public reset-safe asset');
    const fresh = await blocker.evaluate(async prior => {
      const vault = await window.vaultApi.openBrowserVault({ getKey: () => window.key });
      const result = { different: vault.generation !== prior, absent: !(await vault.filesystem.exists('/before-reset.csv')) };
      await vault.close();
      await window.vaultApi.resetBrowserVault();
      return result;
    }, generation);
    assert.deepEqual(fresh, { different: true, absent: true });
    reports.push('Confirmed IDB reset retains both writer locks through blocked deletion, closes connections, preserves public models and permits a fresh open only afterward');
    await context.close();
  }
  {
    const context = await browser.newContext();
    const owner = await context.newPage();
    await installHelpers(owner);
    await owner.evaluate(async () => {
      const source = window.vaultApi.zen.InMemory.create({});
      await source.ready();
      await window.writeLogical(source, '/blocked-migration.csv', window.marker);
      await window.writeOldDatabase('artipodfs', source.store);
      window.migrationDone = false;
      window.blockedDeletion = false;
      const remove = indexedDB.deleteDatabase;
      indexedDB.deleteDatabase = function(name) {
        const request = remove.call(this, name);
        request.addEventListener('blocked', () => { window.blockedDeletion = true; });
        return request;
      };
    });
    const blocker = await context.newPage();
    await installHelpers(blocker);
    await blocker.evaluate(async () => {
      window.heldDatabase = await new Promise((resolve, reject) => {
        const request = indexedDB.open('artipodfs');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
    await owner.evaluate(() => {
      window.migrationTask = window.vaultApi.openBrowserVault({ getKey: () => window.key }).then(vault => {
        window.vault = vault;
        window.migrationDone = true;
      });
    });
    await owner.waitForFunction(() => window.blockedDeletion);
    assert.equal(await owner.evaluate(() => window.migrationDone), false);
    const denied = await blocker.evaluate(async () => {
      try { await window.vaultApi.openBrowserVault({ getKey: () => window.key }); return false; }
      catch (error) { return error.message.includes('another tab'); }
    });
    assert.equal(denied, true, 'migration must retain writer ownership while old DB deletion is blocked');
    await blocker.evaluate(() => window.heldDatabase.close());
    await owner.waitForFunction(() => window.migrationDone);
    assert.equal(await owner.evaluate(() => window.readLogical(window.vault.filesystem, '/blocked-migration.csv')), marker);
    await owner.evaluate(() => window.vault.close());
    reports.push('Legacy IDB migration retains writer locks until a blocked cleanup deletion completes');
    await context.close();
  }
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installHelpers(page);
    const reset = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      await window.writeRawFile(root, 'artipod-models/public-model.bin', 'public reset-safe asset');
      let leased = true;
      const vault = await window.vaultApi.openBrowserVault({ getKey: () => { if (!leased) throw new Error('Lease expired'); return window.key; } });
      await window.writeLogical(vault.filesystem, '/discarded.csv', window.marker);
      await vault.flush();
      leased = false;
      const result = await vault.reset();
      const required = await window.vaultApi.browserVaultRequired();
      const entries = [];
      for await (const name of root.keys()) entries.push(name);
      return { result, required, entries };
    });
    assert.equal(reset.result.warnings.some(warning => warning.includes('Lease expired')), true);
    assert.equal(reset.required, false);
    assert.deepEqual(reset.entries, ['artipod-models']);
    reports.push('Confirmed OPFS reset reports failed lease/flush and still erases private state while preserving public models');
    await context.close();
  }
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installHelpers(page);
    const failure = await page.evaluate(async () => {
      const api = window.vaultApi;
      const vault = await api.openBrowserVault({ getKey: () => window.key });
      await window.writeLogical(vault.filesystem, '/preserved.csv', window.marker);
      await vault.flush();
      const remove = FileSystemDirectoryHandle.prototype.removeEntry;
      FileSystemDirectoryHandle.prototype.removeEntry = function(name, options) {
        if (name === 'artipod-vault') return Promise.reject(new DOMException('Synthetic erase denied', 'NotAllowedError'));
        return remove.call(this, name, options);
      };
      let message;
      try { await vault.reset(); } catch (error) { message = error.message; }
      const required = await api.browserVaultRequired();
      FileSystemDirectoryHandle.prototype.removeEntry = remove;
      const recovered = await api.openBrowserVault({ getKey: () => window.key });
      const value = await window.readLogical(recovered.filesystem, '/preserved.csv');
      await recovered.close();
      await api.resetBrowserVault();
      return { message, required, value, cleared: !(await api.browserVaultRequired()) };
    });
    assert.equal(failure.message, 'Synthetic erase denied');
    assert.equal(failure.required, true);
    assert.equal(failure.value, marker);
    assert.equal(failure.cleared, true);
    reports.push('Erasure failure is reported, retains the required bootstrap and permits explicit lock-protected recovery/reset retry');
    await context.close();
  }
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installHelpers(page);
    assert.equal(await page.evaluate(() => window.vaultApi.browserVaultRequired()), false, 'fresh browser must permit memory-only mode');
    const migration = await page.evaluate(async () => {
      const { zen, openBrowserVault, createBrowserVaultAdapters } = window.vaultApi;
      const root = await navigator.storage.getDirectory();
      await window.writeRawFile(root, `artipod-fs/work/blank/${window.marker}.csv`, `${window.marker}-scratch-body`);
      await window.writeRawFile(root, `artipod-fs/.artipod/oci/refs/${window.marker}.json`, JSON.stringify({ ref: window.marker }));
      await window.writeRawFile(root, 'artipod-fs/.artipod/ui-state.json', JSON.stringify({ workspaces: [{ id: window.marker }] }));
      await window.writeRawFile(root, `${window.marker}-old-root.csv`, `${window.marker}-old-root-body`);
      await window.writeRawFile(root, 'artipod-models/public-model.bin', 'public model asset');
      const upper = await window.legacyUpper();
      for (const [id, bytes] of upper) await window.writeRawFile(root, `artipod-fs/.artipod/uppers/opfs-old/${id}`, bytes);
      const oldRoot = zen.InMemory.create({});
      await oldRoot.ready();
      await window.writeLogical(oldRoot, `/${window.marker}-idb.csv`, `${window.marker}-idb-body`);
      // Old IDB-to-OPFS adoption retained the original database but copied
      // only bytes. Same paths now have OPFS's synthetic modes/timestamps.
      await window.writeLogical(oldRoot, `/work/blank/${window.marker}.csv`, `${window.marker}-scratch-body`);
      await oldRoot.touch(`/work/blank/${window.marker}.csv`, { mode: 0o100600, mtimeMs: 12345 });
      await window.writeOldDatabase('artipodfs', oldRoot.store);
      await window.writeOldDatabase(`artipod-upper::${window.marker}-old-upper`, upper);
      if (!(await window.vaultApi.browserVaultRequired())) throw new Error('Saved legacy workspaces must require a migration key');
      window.beginObserver();
      const adapters = await createBrowserVaultAdapters();
      const legacySources = adapters.legacySources.bind(adapters);
      let interrupted = false;
      adapters.legacySources = async () => (await legacySources()).map(source => source.id !== 'opfs:artipod-fs' ? source : {
        ...source, cleanup: async () => {
          if (!interrupted) {
            interrupted = true;
            const fs = await root.getDirectoryHandle('artipod-fs');
            await fs.removeEntry('work', { recursive: true });
            throw new Error('Synthetic interruption during cleanup');
          }
          await source.cleanup();
        },
      });
      let interruption;
      try { await openBrowserVault({ getKey: () => window.key, adapters }); } catch (error) { interruption = error.message; }
      if (!interruption?.includes('Synthetic interruption')) throw new Error(`Expected interruption, got ${interruption}`);
      const committed = await adapters.readControl();
      if (committed.phase !== 'cleanup') throw new Error('Interrupted cleanup lost the committed generation');
      window.vault = await openBrowserVault({ getKey: () => window.key });
      const fs = window.vault.filesystem;
      const preserved = await window.readLogical(fs, `/work/blank/${window.marker}.csv`);
      const idb = await window.readLogical(fs, `/${window.marker}-idb.csv`);
      const oldRootFile = await window.readLogical(fs, `/${window.marker}-old-root.csv`);
      const copiedUpper = new Uint8Array((await fs.stat(`/.artipod/uppers/${window.marker}-old-upper/0`)).size);
      await fs.read(`/.artipod/uppers/${window.marker}-old-upper/0`, copiedUpper, 0, copiedUpper.length);
      if (!window.vaultApi.isEncryptedBlob(copiedUpper)) throw new Error('Legacy upper blocks were not preserved');
      await window.writeLogical(fs, `/work/new/${window.marker}-new.csv`, `${window.marker}-new-body`);
      await window.vault.flush();
      const models = await (await root.getDirectoryHandle('artipod-models')).getFileHandle('public-model.bin');
      return { backend: window.vault.backend, generation: window.vault.generation, sameGeneration: window.vault.generation === committed.generation,
        preserved, idb, oldRootFile, model: await (await models.getFile()).text(), scan: await window.scanRaw() };
    });
    assert.equal(migration.backend, 'opfs');
    assert.equal(migration.sameGeneration, true);
    assert.equal(migration.preserved, `${marker}-scratch-body`);
    assert.equal(migration.idb, `${marker}-idb-body`);
    assert.equal(migration.oldRootFile, `${marker}-old-root-body`);
    assert.equal(migration.model, 'public model asset');
    assert.deepEqual(migration.scan.violations, []);
    assert.deepEqual(migration.scan.writes, []);
    const contender = await context.newPage();
    await installHelpers(contender);
    const busy = await contender.evaluate(async () => {
      try { await window.vaultApi.openBrowserVault({ getKey: () => window.key }); return false; }
      catch (error) { return error.message.includes('another tab'); }
    });
    assert.equal(busy, true, 'a second tab must not obtain the writer lock');
    await contender.close();
    await page.evaluate(() => window.vault.close());
    await installHelpers(page);
    const reopened = await page.evaluate(async generation => {
      const vault = await window.vaultApi.openBrowserVault({ getKey: () => window.key });
      const value = await window.readLogical(vault.filesystem, `/work/new/${window.marker}-new.csv`);
      const same = vault.generation === generation;
      await vault.close();
      return { value, same };
    }, migration.generation);
    assert.equal(reopened.same, true);
    assert.equal(reopened.value, `${marker}-new-body`);
    reports.push('Real OPFS + legacy root/IDB/upper migration, interrupted cleanup, raw write/at-rest scan, reload, model preservation and two-tab writer exclusion passed');
    await context.close();
  }
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installHelpers(page);
    const fallback = await page.evaluate(async () => {
      const { zen, openBrowserVault } = window.vaultApi;
      const source = zen.InMemory.create({});
      await source.ready();
      await window.writeLogical(source, `/${window.marker}-legacy.csv`, `${window.marker}-legacy-body`);
      await window.writeOldDatabase('browser-git-fs', source.store);
      if (!(await window.vaultApi.browserVaultRequired())) throw new Error('Saved legacy IndexedDB must require a migration key');
      const original = navigator.storage.getDirectory;
      Object.defineProperty(navigator.storage, 'getDirectory', { value: undefined, configurable: true });
      window.beginObserver();
      let vault = await openBrowserVault({ getKey: () => window.key });
      const backend = vault.backend;
      const generation = vault.generation;
      const legacy = await window.readLogical(vault.filesystem, `/${window.marker}-legacy.csv`);
      await window.writeLogical(vault.filesystem, `/${window.marker}-fallback.csv`, `${window.marker}-fallback-body`);
      await vault.flush();
      await vault.close();
      Object.defineProperty(navigator.storage, 'getDirectory', { value: original, configurable: true });
      vault = await openBrowserVault({ getKey: () => window.key, backend: 'opfs' });
      const stayed = vault.backend === 'indexeddb' && vault.generation === generation;
      const saved = await window.readLogical(vault.filesystem, `/${window.marker}-fallback.csv`);
      await vault.close();
      return { backend, legacy, saved, stayed, scan: await window.scanRaw() };
    });
    assert.equal(fallback.backend, 'indexeddb');
    assert.equal(fallback.legacy, `${marker}-legacy-body`);
    assert.equal(fallback.saved, `${marker}-fallback-body`);
    assert.equal(fallback.stayed, true);
    assert.deepEqual(fallback.scan.violations, []);
    assert.deepEqual(fallback.scan.writes, []);
    reports.push('Real encrypted IndexedDB fallback, old IDB migration, raw write/at-rest scan and persisted backend anchoring passed');
    await context.close();
  }
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await installHelpers(page);
    const refused = await page.evaluate(async () => {
      Object.defineProperty(navigator.storage, 'getDirectory', { value: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')), configurable: true });
      try { await window.vaultApi.openBrowserVault({ getKey: () => window.key }); return false; }
      catch (error) { return error.message.includes('OPFS is present but inaccessible'); }
    });
    assert.equal(refused, true);
    reports.push('OPFS permission/API errors fail closed instead of selecting another backing');
    await context.close();
  }
  for (const report of reports) console.log(report);
} finally {
  await browser?.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}
