#!/usr/bin/env node
/**
 * Browser persistence regression for #116. Uses a fresh, disposable browser
 * context and synthetic data only. BASE_URL must be a disposable local
 * `artipod serve --encrypt` serving the freshly built SPA; this test publishes
 * a unique synthetic ref to that server.
 *
 *   BASE_URL=http://127.0.0.1:2786 node scripts/verify-encrypted-storage.mjs
 *
 * Install playwright locally, or set PLAYWRIGHT_MODULE_PATH to its installed
 * directory/index.mjs. CHROMIUM_EXECUTABLE_PATH selects an existing browser;
 * otherwise Playwright's installed Chromium is used. STEP_TIMEOUT_MS defaults
 * to 30000. No persistent browser profile or existing browser tab is opened.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const base = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:2786');
assert(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'BASE_URL must identify a disposable local test server');
const stepTimeout = Number(process.env.STEP_TIMEOUT_MS ?? 30_000);
assert(Number.isFinite(stepTimeout) && stepTimeout > 0, 'STEP_TIMEOUT_MS must be positive');
const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE_PATH;
let playwright;
try {
  playwright = playwrightPath ? require(resolve(playwrightPath)) : require('playwright');
} catch (error) {
  if (!playwrightPath) throw new Error('Playwright is required; install it or set PLAYWRIGHT_MODULE_PATH to an installed Playwright module', { cause: error });
  playwright = await import(pathToFileURL(resolve(playwrightPath)).href);
}

const id = randomUUID();
const names = {
  workspace: `storage-probe-workspace-${id}`,
  directory: `storage-probe-directory-${id}`,
  filename: `storage-probe-filename-${id}.txt`,
  payload: `storage-probe-payload-${id}`,
  target: `storage-probe-target-${id}.txt`,
  label: `storage-probe-snapshot-${id}`,
  ref: `storage-probe-ref-${id}:_1`,
  overlay: `storage-probe-overlay-${id}.txt`,
  editorFile: `storage-probe-editor-${id}.md`,
  editorSaved: `storage-probe-editor-saved-${id}`,
  editorDraft: `storage-probe-editor-unsaved-${id}`,
};
const canary = `observer-canary-${id}`;
const events = [];
const diagnostics = [];
const reports = [];
let browser;
let context;
let page;

/** Runs before app scripts on every navigation, observing page persistence APIs. */
function observePersistence({ markers, canary }) {
  const handles = new WeakMap();
  const streams = new WeakMap();
  const pending = new Set();
  const variants = (text) => [...new Set([
    text, encodeURIComponent(text), encodeURIComponent(encodeURIComponent(text)),
    JSON.stringify(text).slice(1, -1), btoa(text),
    [...text].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    [...text].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
  ])];
  const needles = [...markers, canary].map((marker) => ({ marker, forms: variants(marker) }));
  function track(promise) {
    const task = Promise.resolve(promise).finally(() => pending.delete(task));
    pending.add(task);
    return task;
  }
  function text(value, operation, location) {
    for (const { marker, forms } of needles) {
      if (forms.some((form) => value.includes(form))) {
        track(window.__reportPersistence({ operation, location, marker, canary: marker === canary }));
      }
    }
  }
  function inspect(value, operation, location, seen = new WeakSet()) {
    if (typeof value === 'string') { text(value, operation, location); return; }
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer
        ? new Uint8Array(value).slice()
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      text(new TextDecoder().decode(bytes), operation, location);
      text(new TextDecoder('utf-16le').decode(bytes), operation, location);
    } else if (value instanceof Blob) {
      track(value.arrayBuffer().then((buffer) => inspect(buffer, operation, location)));
    } else if (!(value instanceof CryptoKey)) {
      for (const [key, item] of Object.entries(value)) {
        text(key, operation, location);
        inspect(item, operation, location, seen);
      }
    }
  }
  function wrap(prototype, name, make) {
    const original = prototype?.[name];
    if (typeof original === 'function') prototype[name] = make(original);
  }
  wrap(FileSystemDirectoryHandle.prototype, 'getDirectoryHandle', (original) => async function (name, options) {
    const location = `${handles.get(this) ?? ''}/${name}`;
    text(location, 'opfs-directory', location);
    const handle = await original.call(this, name, options);
    handles.set(handle, location);
    return handle;
  });
  wrap(FileSystemDirectoryHandle.prototype, 'getFileHandle', (original) => async function (name, options) {
    const location = `${handles.get(this) ?? ''}/${name}`;
    text(location, 'opfs-filename', location);
    const handle = await original.call(this, name, options);
    handles.set(handle, location);
    return handle;
  });
  wrap(FileSystemFileHandle.prototype, 'createWritable', (original) => async function (...args) {
    const stream = await original.apply(this, args);
    streams.set(stream, handles.get(this) ?? this.name);
    return stream;
  });
  wrap(FileSystemWritableFileStream.prototype, 'write', (original) => function (value) {
    inspect(value, 'opfs-write', streams.get(this) ?? 'unknown OPFS file');
    return original.call(this, value);
  });
  wrap(FileSystemWritableFileStream.prototype, 'getWriter', (original) => function (...args) {
    const writer = original.apply(this, args);
    const write = writer.write.bind(writer);
    const location = streams.get(this) ?? 'unknown OPFS file';
    writer.write = (value) => { inspect(value, 'opfs-write', location); return write(value); };
    return writer;
  });
  for (const name of ['put', 'add']) wrap(IDBObjectStore.prototype, name, (original) => function (value, key) {
    const location = `${this.transaction.db.name}/${this.name}`;
    inspect(value, 'idb-write', location);
    inspect(key, 'idb-key', location);
    return key === undefined ? original.call(this, value) : original.call(this, value, key);
  });
  wrap(IDBFactory.prototype, 'open', (original) => function (name, ...args) {
    text(name, 'idb-database-name', name);
    return original.call(this, name, ...args);
  });
  wrap(IDBDatabase.prototype, 'createObjectStore', (original) => function (name, ...args) {
    text(name, 'idb-store-name', `${this.name}/${name}`);
    return original.call(this, name, ...args);
  });
  wrap(Storage.prototype, 'setItem', (original) => function (key, value) {
    inspect(key, 'web-storage-key', key);
    inspect(value, 'web-storage-write', key);
    return original.call(this, key, value);
  });
  window.__drainPersistenceObserver = async () => {
    while (pending.size) await Promise.all([...pending]);
  };
  window.__inspectRawPersistence = async () => {
    const summary = { opfsFiles: 0, opfsBytes: 0, idbRecords: 0, vanishedEntries: 0, retriedReads: 0 };
    async function readCurrentFile(handle) {
      for (let attempt = 0; ; attempt++) {
        try {
          // A File is a snapshot. Chromium can invalidate it if an atomic
          // replacement commits between getFile() and arrayBuffer().
          return await (await handle.getFile()).arrayBuffer();
        } catch (error) {
          if (error?.name !== 'NotReadableError' || attempt >= 4) throw error;
          summary.retriedReads++;
        }
      }
    }
    async function walk(dir, parent = '') {
      for await (const [name, handle] of dir.entries()) {
        const location = `${parent}/${name}`;
        text(location, 'raw-opfs-path', location);
        try {
          if (handle.kind === 'directory') await walk(handle, location);
          else {
            const bytes = await readCurrentFile(handle);
            inspect(bytes, 'raw-opfs-bytes', location);
            summary.opfsFiles++;
            summary.opfsBytes += bytes.byteLength;
          }
        } catch (error) {
          // Atomic replacement can retire a block after directory iteration.
          // Every preceding write remains covered by the independent hooks.
          if (error?.name !== 'NotFoundError') throw error;
          summary.vanishedEntries++;
        }
      }
    }
    await walk(await navigator.storage.getDirectory());
    for (const database of await indexedDB.databases()) {
      if (!database.name) continue;
      text(database.name, 'raw-idb-database', database.name);
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(database.name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        for (const name of db.objectStoreNames) {
          text(name, 'raw-idb-store', `${db.name}/${name}`);
          await new Promise((resolve, reject) => {
            const request = db.transaction(name).objectStore(name).openCursor();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) { resolve(); return; }
              inspect(cursor.key, 'raw-idb-key', `${db.name}/${name}`);
              inspect(cursor.value, 'raw-idb-value', `${db.name}/${name}`);
              summary.idbRecords++;
              cursor.continue();
            };
          });
        }
      } finally { db.close(); }
    }
    for (const storage of [localStorage, sessionStorage]) for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      inspect(key, 'raw-web-storage-key', key);
      inspect(storage.getItem(key), 'raw-web-storage-value', key);
    }
    await window.__drainPersistenceObserver();
    return summary;
  };
}

async function step(name, fn) {
  process.stdout.write(`[browser-storage] ${name}\n`);
  let timer;
  try {
    return await Promise.race([fn(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${name} (${stepTimeout}ms)`)), stepTimeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function ready(ref) {
  await page.waitForFunction((ref) => {
    const pod = window.__artipod;
    return !!pod && (ref ? pod.basis?.ref === ref : !pod.basis);
  }, ref, { timeout: stepTimeout });
  assert.equal(await page.getByText(/Memory-only workspace:/).count(), 0, 'Encrypted test must never fall back to volatile or plaintext storage');
}

async function audit(stage) {
  const summary = await page.evaluate(() => window.__inspectRawPersistence());
  const leaks = events.filter((event) => !event.canary);
  assert.deepEqual(leaks, [], `Plaintext reached backing persistence during ${stage}: ${JSON.stringify(leaks)}`);
  assert(summary.opfsFiles + summary.idbRecords > 0, 'Test must observe durable browser storage');
  reports.push({ stage, ...summary });
}

async function checkFiles(ref) {
  await page.evaluate(async ({ names, ref }) => {
    const pod = window.__artipod;
    const root = ref ? pod.basis.at : `/work/${names.workspace}`;
    const p = pod.zfs.promises;
    const text = await p.readFile(`${root}/${names.directory}/${names.filename}`, 'utf8');
    if (text !== names.payload) throw new Error('Persisted file contents changed');
    // Overlay publication currently materializes symlinks as ordinary file
    // contents. Exact link preservation belongs to scratch/root persistence.
    if (!ref) {
      const target = await p.readlink(`${root}/${names.directory}/link`);
      if (target !== names.target) throw new Error('Persisted symlink target changed');
    }
    const snapshots = await pod.snapshots.list();
    if (!snapshots.some((snapshot) => snapshot.label === names.label)) throw new Error('Snapshot label did not survive');
  }, { names, ref });
}

try {
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  context = await browser.newContext();
  context.setDefaultTimeout(stepTimeout);
  await context.exposeBinding('__reportPersistence', (_, event) => { events.push(event); });
  await context.addInitScript(observePersistence, { markers: Object.values(names), canary });
  page = await context.newPage();
  await page.clock.install({ time: new Date() });
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (['warning', 'error'].includes(message.type())) diagnostics.push(`${message.type()}: ${message.text()}`); });

  await step('open encrypted scratch workspace', async () => {
    const url = new URL(base);
    url.searchParams.set('artipod', names.workspace);
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await ready();
  });
  await step('verify interception catches temporary OPFS and IndexedDB writes', async () => {
    await page.evaluate(async (canary) => {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle('observer-canary', { create: true });
      const stream = await file.createWritable();
      await stream.write(canary);
      await stream.close();
      // Exercise the scan's stale-File retry deterministically, and prove it
      // still fails when a file remains unreadable instead of skipping bytes.
      const getFile = FileSystemFileHandle.prototype.getFile;
      let failures = 2;
      let reads = 0;
      FileSystemFileHandle.prototype.getFile = async function (...args) {
        if (this.name === 'observer-canary') {
          reads++;
          if (failures-- > 0) return { arrayBuffer: async () => { throw new DOMException('Synthetic stale File', 'NotReadableError'); } };
        }
        return getFile.apply(this, args);
      };
      try {
        const scan = await window.__inspectRawPersistence();
        if (reads !== 3 || scan.retriedReads < 2) throw new Error('Raw scan did not reacquire stale File snapshots');
        failures = Infinity;
        reads = 0;
        let rejected = false;
        try { await window.__inspectRawPersistence(); }
        catch (error) { if (error?.name !== 'NotReadableError') throw error; rejected = true; }
        if (!rejected || reads !== 5) throw new Error('Raw scan skipped a persistently unreadable file');
      } finally {
        FileSystemFileHandle.prototype.getFile = getFile;
        await root.removeEntry('observer-canary');
      }
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('artipod-observer-canary', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('records');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        tx.objectStore('records').put(canary, 'canary');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase('artipod-observer-canary');
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
      });
      await window.__drainPersistenceObserver();
    }, canary);
    assert(events.some((event) => event.canary && event.operation === 'opfs-write'), 'OPFS interception was not active');
    assert(events.some((event) => event.canary && event.operation === 'idb-write'), 'IndexedDB interception was not active');
  });
  await step('write names, payload, symlink, snapshot and registry metadata', async () => {
    await page.evaluate(async (names) => {
      const pod = window.__artipod;
      const p = pod.zfs.promises;
      const root = `/work/${names.workspace}/${names.directory}`;
      await p.mkdir(root, { recursive: true });
      await p.writeFile(`${root}/${names.filename}`, names.payload);
      await p.writeFile(`${root}/${names.target}`, 'synthetic symlink target');
      await p.symlink(names.target, `${root}/link`);
      await pod.snapshots.create({ label: names.label });
      const registry = JSON.parse(await p.readFile('/.artipod/ui-state.json', 'utf8'));
      if (!registry.workspaces.some((entry) => entry.id === names.workspace)) throw new Error('Scratch registry entry was not recorded');
    }, names);
    await audit('scratch and snapshot');
  });
  await step('reload recovers exact scratch files and snapshot', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    await checkFiles();
    await audit('scratch reload');
  });
  await step('a second tab cannot open the encrypted root concurrently', async () => {
    const second = await context.newPage();
    try {
      await second.goto(base.href, { waitUntil: 'domcontentloaded' });
      await second.getByRole('heading', { name: 'Browser storage could not open', exact: true }).waitFor();
      assert.match(await second.locator('body').innerText(), /another tab|writer/i, 'Second tab must explain why storage is unavailable');
      assert.equal(await second.evaluate(() => !!window.__artipod), false, 'Second tab mounted a concurrent workspace');
      await audit('second writer refused');
    } finally { await second.close(); }
  });
  await step('offline reload restores the wrapped unexpired grant', async () => {
    await page.getByRole('button', { name: 'online', exact: true }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    await checkFiles();
    await page.getByRole('button', { name: 'offline (forced)', exact: true }).click();
    await audit('offline reload');
  });
  await step('lease release blocks previously cached reads and login restores access', async () => {
    await page.evaluate(() => { window.__lockedProbeFs = window.__artipod.zfs; });
    await page.getByRole('button', { name: 'Release the key lease', exact: true }).click();
    await page.getByRole('heading', { name: 'Browser storage is locked', exact: true }).waitFor();
    const denied = await page.evaluate(async (names) => {
      try { await window.__lockedProbeFs.promises.readFile(`/work/${names.workspace}/${names.directory}/${names.filename}`); return false; }
      catch { return true; }
    }, names);
    assert(denied, 'Cached plaintext remained readable through the filesystem after lease release');
    await audit('locked');
    await page.getByRole('button', { name: /encrypted · locked — login/ }).click();
    await ready();
    await checkFiles();
    await audit('unlocked');
  });
  await step('dirty editor text survives release and offline expiry without being saved', async () => {
    await page.evaluate(async (names) => {
      const pod = window.__artipod;
      const root = `/work/${names.workspace}`;
      await pod.zfs.promises.writeFile(`${root}/${names.editorFile}`, names.editorSaved);
      const shell = pod.createSandbox({ confineTo: root });
      try {
        const result = await shell.exec(`edit '/${names.editorFile}'`);
        if (result.exitCode) throw new Error(`Could not open editor: ${result.stderr}`);
      } finally { shell.dispose(); }
    }, names);
    const editable = () => page.locator('.ProseMirror[contenteditable="true"]:visible').first();
    const waitForEditorText = (text) => page.waitForFunction((text) =>
      document.querySelector('.ProseMirror[contenteditable="true"]')?.textContent === text, text);
    await editable().waitFor();
    // RichEditor loads its markdown asynchronously after mounting. Typing
    // before that seed finishes would test its initialization race instead.
    await waitForEditorText(names.editorSaved);
    await editable().fill(names.editorDraft);
    await page.getByLabel('Unsaved changes', { exact: true }).waitFor();
    assert.equal(await editable().textContent(), names.editorDraft, 'Editor did not accept the synthetic keystrokes');
    await page.getByRole('button', { name: 'Release the key lease', exact: true }).click();
    await page.getByRole('heading', { name: 'Browser storage is locked', exact: true }).waitFor();
    await audit('unsaved editor while locked');
    await page.getByRole('button', { name: /encrypted · locked — login/ }).click();
    await ready();
    await page.getByLabel('Unsaved changes', { exact: true }).waitFor();
    await waitForEditorText(names.editorDraft);
    assert.equal(await editable().textContent(), names.editorDraft, 'Lease release discarded editor text');
    const readSavedText = () => page.evaluate(async (names) => window.__artipod.zfs.promises.readFile(`/work/${names.workspace}/${names.editorFile}`, 'utf8'), names);
    assert.equal(await readSavedText(), names.editorSaved, 'Unlock silently saved an unsaved draft');

    await page.getByRole('button', { name: 'online', exact: true }).click();
    await page.evaluate(() => window.__artipod.zfs.promises.mkdir('/.artipod', { recursive: true }));
    const remaining = await page.evaluate(() => {
      const expiresAt = window.__artipod.locker.status()[0]?.expiresAt;
      if (!expiresAt) throw new Error('No broker lease expiry is available');
      return expiresAt - Date.now();
    });
    await page.clock.fastForward(Math.max(1, remaining + 1000));
    await page.getByRole('heading', { name: 'Browser storage is locked', exact: true }).waitFor();
    await audit('unsaved editor after offline expiry');
    // The server uses real time. Restore wall time before requesting its next
    // signed lease, after proving that expiry actually unmounted the editor.
    await page.clock.setSystemTime(new Date());
    await page.getByRole('button', { name: 'offline (forced)', exact: true }).click();
    await page.getByRole('button', { name: /encrypted · locked — login/ }).click();
    await ready();
    await page.getByLabel('Unsaved changes', { exact: true }).waitFor();
    await waitForEditorText(names.editorDraft);
    assert.equal(await editable().textContent(), names.editorDraft, 'Offline expiry discarded editor text');
    assert.equal(await readSavedText(), names.editorSaved, 'Expiry recovery changed saved file contents');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByLabel('Unsaved changes', { exact: true }).waitFor({ state: 'detached' });
    // The markdown serializer terminates a paragraph with one newline.
    assert.equal(await readSavedText(), `${names.editorDraft}\n`, 'Explicit save did not write the restored editor text');
    await audit('restored editor explicitly saved');
  });
  for (const interruption of ['release', 'expiry']) await step(`recover a queued write interrupted by ${interruption} without losing drafts`, async () => {
    const editable = page.locator('.ProseMirror[contenteditable="true"]:visible').first();
    const draft = `${names.editorDraft}-${interruption}-recovery`;
    const saved = await page.evaluate(async (names) => window.__artipod.zfs.promises.readFile(`/work/${names.workspace}/${names.editorFile}`, 'utf8'), names);
    await editable.fill(draft);
    await page.getByLabel('Unsaved changes', { exact: true }).waitFor();
    if (interruption === 'expiry') {
      await page.getByRole('button', { name: 'online', exact: true }).click();
      await page.evaluate(() => window.__artipod.zfs.promises.mkdir('/.artipod', { recursive: true }));
    }
    // Hold encryption before its first backing commit so lease revocation
    // leaves the saved generation intact while poisoning the pending queue.
    await page.evaluate(async (names) => {
      const encrypt = SubtleCrypto.prototype.encrypt;
      let resume;
      let entered;
      const held = new Promise(resolve => { resume = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      SubtleCrypto.prototype.encrypt = async function (...args) {
        entered();
        await held;
        return encrypt.apply(this, args);
      };
      window.__resumePendingEncryption = () => { SubtleCrypto.prototype.encrypt = encrypt; resume(); };
      window.__interruptedWrite = window.__artipod.zfs.promises.writeFile(`/work/${names.workspace}/${names.editorFile}`, names.editorSaved)
        .then(() => ({ saved: true }), error => ({ saved: false, error: error.message }));
      await started;
    }, names);
    try {
      if (interruption === 'release') await page.getByRole('button', { name: 'Release the key lease', exact: true }).click();
      else {
        const remaining = await page.evaluate(() => window.__artipod.locker.status()[0].expiresAt - Date.now());
        await page.clock.fastForward(Math.max(1, remaining + 1000));
      }
      await page.getByRole('heading', { name: 'Browser storage is locked', exact: true }).waitFor();
    } finally { await page.evaluate(() => window.__resumePendingEncryption()); }
    const result = await page.evaluate(() => window.__interruptedWrite);
    assert.equal(result.saved, false, 'A write interrupted by lease revocation was reported as saved');
    if (interruption === 'expiry') {
      await page.clock.setSystemTime(new Date());
      await page.getByRole('button', { name: 'offline (forced)', exact: true }).click();
    }
    await page.getByRole('button', { name: /encrypted · locked — login/ }).click();
    await page.getByRole('heading', { name: 'Browser storage could not open', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Recover saved storage', exact: true }).click();
    await ready();
    await page.getByRole('alert').filter({ hasText: 'Storage reopened from its saved generation after a failed write.' }).waitFor();
    await page.getByLabel('Unsaved changes', { exact: true }).waitFor();
    await page.waitForFunction(draft => document.querySelector('.ProseMirror[contenteditable="true"]')?.textContent === draft, draft);
    const after = await page.evaluate(async (names) => window.__artipod.zfs.promises.readFile(`/work/${names.workspace}/${names.editorFile}`, 'utf8'), names);
    assert.equal(after, saved, 'Recovery reported the interrupted write as durable or silently saved the draft');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByLabel('Unsaved changes', { exact: true }).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(async (names) => window.__artipod.zfs.promises.readFile(`/work/${names.workspace}/${names.editorFile}`, 'utf8'), names), `${draft}\n`, 'The recovered draft could not be saved explicitly');
    await audit(`queued write recovery after ${interruption}`);
  });
  await step('publish scratch and push an overlay with filename metadata', async () => {
    const result = await page.evaluate(async (names) => {
      const pod = window.__artipod;
      const shell = pod.createSandbox({ confineTo: `/work/${names.workspace}` });
      try { return await shell.exec(`artipod publish '${names.ref}'`); }
      finally { shell.dispose(); }
    }, names);
    assert.equal(result.exitCode, 0, `Publish failed: ${result.stderr}`);
    await ready(names.ref);
    await checkFiles(names.ref);
    await page.evaluate(async (names) => {
      const pod = window.__artipod;
      await pod.zfs.promises.writeFile(`${pod.basis.at}/${names.overlay}`, names.payload);
      await pod.pushBasis();
    }, names);
    await audit('publish and overlay push');
  });
  await step('reload ref, hydrate published files, and recover overlay contents', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(names.ref);
    await checkFiles(names.ref);
    const text = await page.evaluate(async (names) => window.__artipod.zfs.promises.readFile(`${window.__artipod.basis.at}/${names.overlay}`, 'utf8'), names);
    assert.equal(text, names.payload, 'Published overlay did not survive reload');
    await audit('published reload and hydration');
  });
  await step('reload without a grant or key server remains locked', async () => {
    await page.getByRole('button', { name: 'Release the key lease', exact: true }).click();
    await page.getByRole('heading', { name: 'Browser storage is locked', exact: true }).waitFor();
    await context.route('**/api/keys**', (route) => route.abort());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Browser storage is locked', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => !!window.__artipod), false, 'Locked reload mounted a workspace');
    await audit('missing grant and offline key server');
    await context.unroute('**/api/keys**');
  });
  await step('online reload after release keeps a visible login until explicit unlock', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Browser storage is locked', exact: true }).waitFor();
    await page.getByRole('button', { name: /encrypted · locked — login/ }).waitFor();
    assert.equal(await page.evaluate(() => !!window.__artipod), false, 'Online reload automatically reopened a released workspace');
    await audit('released grant online reload');
    await page.getByRole('button', { name: /encrypted · locked — login/ }).click();
    await ready(names.ref);
    await checkFiles(names.ref);
    await audit('explicit login after released online reload');
  });
  await step('a confirmed non-broker service offers visibly memory-only editing', async () => {
    const volatile = await browser.newContext();
    volatile.setDefaultTimeout(stepTimeout);
    await volatile.exposeBinding('__reportPersistence', (_, event) => { events.push(event); });
    await volatile.addInitScript(observePersistence, { markers: Object.values(names), canary });
    // Model the real non-broker contract without changing the encrypted test
    // server: a definitive keys 404 and an empty public catalog.
    await volatile.route('**/api/keys', (route) => route.fulfill({ status: 404, body: '{"error":"not found"}', contentType: 'application/json' }));
    await volatile.route('**/api/pods/refs', (route) => route.fulfill({ status: 200, body: '[]', contentType: 'application/json' }));
    const volatilePage = await volatile.newPage();
    const url = new URL(base);
    url.searchParams.set('artipod', `${names.workspace}-memory`);
    try {
      await volatilePage.goto(url.href, { waitUntil: 'domcontentloaded' });
      await volatilePage.getByRole('alert').filter({ hasText: 'Memory-only workspace:' }).waitFor();
      await volatilePage.waitForFunction(() => !!window.__artipod);
      await volatilePage.evaluate(async (names) => {
        await window.__artipod.zfs.promises.writeFile(`/work/${names.workspace}-memory/${names.filename}`, names.payload);
      }, names);
      const summary = await volatilePage.evaluate(() => window.__inspectRawPersistence());
      assert.equal(summary.opfsFiles, 0, 'Volatile editing created persistent filesystem blocks');
      assert.equal(summary.idbRecords, 0, 'Volatile editing created persistent workspace records');
      assert.deepEqual(events.filter((event) => !event.canary), [], 'Volatile work reached backing persistence');
      await volatilePage.reload({ waitUntil: 'domcontentloaded' });
      await volatilePage.getByRole('alert').filter({ hasText: 'Memory-only workspace:' }).waitFor();
      await volatilePage.waitForFunction(() => !!window.__artipod);
      const missing = await volatilePage.evaluate(async (names) => {
        try { await window.__artipod.zfs.promises.readFile(`/work/${names.workspace}-memory/${names.filename}`); return false; }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
      }, names);
      assert(missing, 'The memory-only warning must describe actual reload behavior');
      reports.push({ stage: 'confirmed 404 memory-only mode', ...summary });
    } finally { await volatile.close(); }
  });
  assert.deepEqual(diagnostics.filter((message) => message.startsWith('pageerror:')), [], 'Application produced unhandled browser errors');
  process.stdout.write(`${JSON.stringify({ result: 'passed', browser: browser.version(), checks: reports, observedCanaryWrites: events.filter((event) => event.canary).length, plaintextLeaks: 0, unhandledBrowserErrors: 0 }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  if (page) {
    process.stderr.write(`URL: ${page.url()}\n`);
    try { process.stderr.write(`Page text: ${(await page.locator('body').innerText({ timeout: 1500 })).slice(0, 6000)}\n`); }
    catch { /* The page may have closed while reporting a browser failure. */ }
  }
  process.stderr.write(`${diagnostics.slice(-30).join('\n')}\n`);
  process.exitCode = 1;
} finally {
  await context?.close();
  await browser?.close();
}
