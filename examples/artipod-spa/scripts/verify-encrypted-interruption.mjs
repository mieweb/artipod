#!/usr/bin/env node
/**
 * Deterministic #129 regression against real native browser storage. Each case
 * owns a disposable browser context. A page is destroyed at OPFS creation,
 * write, or close, and the replacement page authenticates the saved generation.
 * IndexedDB separately exercises native transaction abort and committed writes.
 * Reports contain only synthetic record IDs, ciphertext lengths and safe
 * envelope fields; keys, nonces, grants and private payloads are never logged.
 * PLAYWRIGHT_MODULE_PATH / CHROMIUM_EXECUTABLE_PATH follow the SPA harness.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  export {openBrowserVault} from './src/storage/browser-vault.ts';
  export {configureStorageRoot} from './src/sandbox/storage.ts';
` }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'vaultApi', target: 'es2022' });
const server = createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', request.url === '/vault.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/vault.js' ? bundle.outputFiles[0].contents : '<!doctype html><script src="/vault.js"></script>');
});
await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
const url = `http://127.0.0.1:${server.address().port}`;
const block = 129129;
const reports = [];
let browser;

/** Installed before app code so even the first root block write is checked. */
function helpers() {
  const handles = new WeakMap();
  const streams = new WeakMap();
  window.firstWrites = [];
  window.hold = null;
  const stop = async (operation, record) => {
    if (window.hold !== operation) return;
    window.interruption = { operation, record };
    await new Promise(() => {});
  };
  const describe = bytes => {
    const magic = new TextDecoder().decode(bytes.slice(0, 8)) === 'APODENC1' ? 'APODENC1' : bytes.length ? 'not-envelope' : 'empty';
    let envelope = null;
    if (magic === 'APODENC1' && bytes.length >= 12) {
      const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, false);
      const header = JSON.parse(new TextDecoder().decode(bytes.slice(12, 12 + length)));
      envelope = { formatVersion: header.formatVersion, cipher: header.cipher, plaintextSize: header.plaintextSize, chunkSize: header.chunkSize, chunks: header.nonces.length };
    }
    return { length: bytes.length, magic, envelope };
  };
  const inspectWrite = (record, value) => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const description = describe(bytes);
    if (description.magic !== 'APODENC1') throw new Error('A first backing write was not an encrypted envelope');
    window.firstWrites.push({ record, ...description });
  };
  const file = FileSystemDirectoryHandle.prototype.getFileHandle;
  FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
    const handle = await file.call(this, name, options);
    handles.set(handle, name);
    if (options?.create && name.startsWith('.artipod-stage-v1-129129-')) await stop('created', name);
    return handle;
  };
  const writable = FileSystemFileHandle.prototype.createWritable;
  FileSystemFileHandle.prototype.createWritable = async function (...args) {
    const stream = await writable.apply(this, args);
    streams.set(stream, handles.get(this) ?? this.name);
    return stream;
  };
  const write = FileSystemWritableFileStream.prototype.write;
  FileSystemWritableFileStream.prototype.write = async function (value) {
    const name = streams.get(this);
    inspectWrite(name, value);
    const result = await write.call(this, value);
    if (name?.startsWith('.artipod-stage-v1-129129-')) await stop('written', name);
    return result;
  };
  const close = FileSystemWritableFileStream.prototype.close;
  FileSystemWritableFileStream.prototype.close = async function () {
    const result = await close.call(this);
    const name = streams.get(this);
    if (name?.startsWith('.artipod-stage-v1-129129-')) await stop('closed', name);
    return result;
  };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    if (this.name === 'blocks') inspectWrite(String(key), value);
    const request = put.apply(this, arguments);
    if (this.name === 'blocks' && key === 129129 && window.hold === 'abort') this.transaction.abort();
    return request;
  };
  window.openVault = async backend => {
    // An isolated synthetic key is recreated only inside each disposable page.
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(19), 'AES-GCM', false, ['encrypt', 'decrypt']);
    window.vault = await vaultApi.openBrowserVault({ backend, getKey: () => key });
    window.zfs = await vaultApi.configureStorageRoot(window.vault.filesystem, { protectedPersistence: true });
  };
  window.scan = async (backend, generation) => {
    const records = [];
    const add = async (id, value) => {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      records.push({ id: String(id), ...describe(bytes), digest });
    };
    if (backend === 'opfs') {
      const directory = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('artipod-vault')).getDirectoryHandle(generation);
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== 'file') throw new Error('Unexpected backing subdirectory');
        await add(name, await (await handle.getFile()).arrayBuffer());
      }
    } else {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(`artipod-vault-blocks-${generation}`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const rows = await new Promise((resolve, reject) => {
          const rows = [];
          const request = db.transaction('blocks').objectStore('blocks').openCursor();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) { resolve(rows); return; }
            rows.push([cursor.key, cursor.value]); cursor.continue();
          };
        });
        for (const [id, value] of rows) await add(id, value);
      } finally { db.close(); }
    }
    return records.sort((a, b) => a.id.localeCompare(b.id));
  };
  window.seed = async () => {
    const p = window.zfs.promises;
    await p.mkdir('/saved-directory', { recursive: true });
    await p.writeFile('/saved-directory/saved-name.txt', 'synthetic saved contents');
    await p.chmod('/saved-directory/saved-name.txt', 0o640);
    await p.symlink('saved-name.txt', '/saved-directory/saved-link');
    await p.mkdir('/.artipod/oci', { recursive: true });
    await p.writeFile('/.artipod/ui-state.json', JSON.stringify({ actor: 'synthetic-actor', workspaces: [{ id: 'synthetic-workspace', kind: 'blank', encrypted: true, mode: 'rw' }] }));
    await p.writeFile('/.artipod/oci/settings.json', JSON.stringify({ offline: false }));
    await window.vault.flush();
  };
  window.checkSaved = async () => {
    const p = window.zfs.promises;
    if (await p.readFile('/saved-directory/saved-name.txt', 'utf8') !== 'synthetic saved contents') throw new Error('Saved contents changed');
    if ((await p.readdir('/saved-directory')).sort().join() !== 'saved-link,saved-name.txt') throw new Error('Saved names changed');
    if ((await p.stat('/saved-directory/saved-name.txt')).mode % 0o1000 !== 0o640) throw new Error('Saved mode changed');
    if (await p.readlink('/saved-directory/saved-link') !== 'saved-name.txt') throw new Error('Saved symlink changed');
    if (await p.readFile('/.artipod/ui-state.json', 'utf8') !== JSON.stringify({ actor: 'synthetic-actor', workspaces: [{ id: 'synthetic-workspace', kind: 'blank', encrypted: true, mode: 'rw' }] })) throw new Error('Saved registry changed');
    if (await p.readFile('/.artipod/oci/settings.json', 'utf8') !== JSON.stringify({ offline: false })) throw new Error('Saved preference changed');
  };
}

async function newPage(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(url);
  await page.waitForFunction(() => !!window.vaultApi);
  return page;
}
const canonical = records => records.filter(record => /^\d+$/.test(record.id));
const reportRecords = records => records.map(({ digest, ...record }) => record);

try {
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (const backend of ['opfs', 'indexeddb']) for (const interruption of backend === 'opfs' ? ['created', 'written', 'closed'] : ['abort', 'committed']) {
    process.stdout.write(`[browser-interruption] ${backend}: ${interruption}\n`);
    const context = await browser.newContext();
    await context.addInitScript(helpers);
    try {
      let page = await newPage(context);
      await page.evaluate(async backend => { await window.openVault(backend); await window.seed(); }, backend);
      const generation = await page.evaluate(() => window.vault.generation);
      const before = await page.evaluate(({ backend, generation }) => window.scan(backend, generation), { backend, generation });
      assert(before.length > 0 && before.every(record => record.magic === 'APODENC1'));
      const writesBefore = await page.evaluate(() => window.firstWrites.length);
      assert(writesBefore > 0, 'The first root backing write was not observed');
      const competitor = await newPage(context);
      const lockError = await competitor.evaluate(async backend => {
        try { await window.openVault(backend); return null; } catch (error) { return error.message; }
      }, backend);
      assert.match(lockError ?? '', /writer|another tab/i, 'The real browser writer lock was not enforced');
      await competitor.close();
      await page.evaluate(({ interruption, block }) => {
        window.hold = interruption;
        // Target an unreferenced synthetic block so these cases test per-block
        // publication, independently of the documented ZenFS transaction limit.
        window.pending = window.vault.filesystem.store.set(block, new TextEncoder().encode('synthetic interrupted block'))
          .then(() => ({ saved: true }), error => ({ saved: false, error: error.message }));
      }, { interruption, block });
      if (backend === 'opfs') await page.waitForFunction(() => !!window.interruption);
      else {
        const result = await page.evaluate(() => window.pending);
        assert.equal(result.saved, interruption === 'committed', 'IDB mutation did not follow its native transaction outcome');
      }
      const interrupted = await page.evaluate(({ backend, generation }) => window.scan(backend, generation), { backend, generation });
      assert.deepEqual(canonical(interrupted).filter(record => record.id !== String(block)), before, 'An interrupted new block modified a saved canonical record');
      if (backend === 'opfs') {
        assert(!canonical(interrupted).some(record => record.id === String(block)), 'A new numeric block appeared before ciphertext publication');
        // Chromium can expose its own encrypted .crswap while a stream is
        // open; that native scratch entry disappears when the page dies.
        const stages = interrupted.filter(record => /^\.artipod-stage-v1-\d+-[a-f0-9]{32}$/.test(record.id));
        assert.equal(stages.length, 1, `The deterministic interruption did not leave one identifiable stage: ${JSON.stringify(reportRecords(stages))}`);
        assert.equal(stages[0].length > 0, interruption === 'closed', 'Native close was not the ciphertext visibility boundary');
      }
      assert.equal((await page.evaluate(() => window.firstWrites.length)) > writesBefore, interruption !== 'created', 'First-write observation did not match the native interruption boundary');
      await page.close(); // Kill pending JS/native stream ownership, as navigation does.
      page = await newPage(context);
      await page.evaluate(backend => window.openVault(backend), backend);
      const after = await page.evaluate(({ backend, generation }) => window.scan(backend, generation), { backend, generation });
      const expected = interruption === 'committed' ? interrupted : before;
      assert.deepEqual(after, expected, 'Reopen did not preserve the exact saved ciphertext or discard only interrupted stages');
      const recovery = await page.evaluate(() => ({ count: window.vault.filesystem.recoveredStages, warning: window.vault.recoveryWarning }));
      assert.equal(recovery.count, backend === 'opfs' ? 1 : 0, 'Recovered stage count did not match the native interruption');
      assert.equal(!!recovery.warning, backend === 'opfs', 'Interrupted OPFS writes must retain a visible recovery warning');
      await page.evaluate(() => window.checkSaved());
      if (interruption === 'committed') {
        assert.equal(await page.evaluate(block => new TextDecoder().decode(window.vault.filesystem.store.cached(block)), block), 'synthetic interrupted block');
      }
      reports.push({ backend, interruption, recordsAtInterruption: reportRecords(interrupted.filter(record => record.id === String(block) || record.id.startsWith('.artipod-stage-v1-'))), savedRecords: before.length, recoveredStages: recovery.count, writerLock: 'enforced', exactSavedState: 'preserved' });
    } finally { await context.close(); }
  }
  process.stdout.write('[browser-interruption] opfs: failed authentication preserves every original record\n');
  const corrupt = await browser.newContext();
  await corrupt.addInitScript(helpers);
  try {
    let page = await newPage(corrupt);
    await page.evaluate(async () => { await window.openVault('opfs'); await window.seed(); });
    const generation = await page.evaluate(() => window.vault.generation);
    await page.evaluate(async generation => {
      const directory = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('artipod-vault')).getDirectoryHandle(generation);
      const source = new Uint8Array(await (await (await directory.getFileHandle('0')).getFile()).arrayBuffer());
      source[source.length - 1] ^= 1; // Preserve envelope syntax; fail AES-GCM authentication.
      const staged = await directory.getFileHandle(`.artipod-stage-v1-129129-${'a'.repeat(32)}`, { create: true });
      const stream = await staged.createWritable(); await stream.write(source); await stream.close();
      await directory.getFileHandle(`.artipod-stage-v1-129130-${'b'.repeat(32)}`, { create: true });
    }, generation);
    const before = await page.evaluate(generation => window.scan('opfs', generation), generation);
    await page.close();
    page = await newPage(corrupt);
    const failure = await page.evaluate(async () => {
      try { await window.openVault('opfs'); return false; } catch { return true; }
    });
    assert(failure, 'An unauthenticated nonempty stage must fail closed');
    assert.deepEqual(await page.evaluate(generation => window.scan('opfs', generation), generation), before, 'Failed authentication modified original records or prematurely removed an empty stage');
    reports.push({ backend: 'opfs', interruption: 'corrupt stage authentication', originalRecords: before.length, failedRecovery: 'all originals preserved' });
  } finally { await corrupt.close(); }
  process.stdout.write(`${JSON.stringify({ result: 'passed', browser: browser.version(), checks: reports }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolveClosed => server.close(resolveClosed));
}
