#!/usr/bin/env node
/**
 * Browser persistence regressions for #116 and #129. Uses a fresh, disposable browser
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
 * TEST_STORAGE_BACKEND=opfs|indexeddb requires that actual persistent backend.
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
const backend = process.env.TEST_STORAGE_BACKEND ?? 'opfs';
assert(['opfs', 'indexeddb'].includes(backend), 'TEST_STORAGE_BACKEND must be opfs or indexeddb');
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
  queuedOverlay: `storage-probe-queued-overlay-${id}.txt`,
  queuedPayload: `storage-probe-queued-payload-${id}`,
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
function observePersistence({ markers, canary, backend }) {
  localStorage.setItem('artipod-sync-storage-backend', backend);
  const handles = new WeakMap();
  const streams = new WeakMap();
  const pending = new Set();
  let interruption;
  window.__armOpfsInterruption = operation => { interruption = operation; };
  async function hold(operation, location) {
    if (interruption !== operation || !/\/\.artipod-stage-v1-\d+-[a-f0-9]{32}$/.test(location)) return;
    interruption = undefined;
    window.__opfsInterruption = { operation, location };
    await new Promise(() => {});
  }
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
    if (options?.create) await hold('created', location);
    return handle;
  });
  wrap(FileSystemFileHandle.prototype, 'createWritable', (original) => async function (...args) {
    const stream = await original.apply(this, args);
    streams.set(stream, handles.get(this) ?? this.name);
    return stream;
  });
  wrap(FileSystemWritableFileStream.prototype, 'write', (original) => async function (value) {
    const location = streams.get(this) ?? 'unknown OPFS file';
    inspect(value, 'opfs-write', location);
    const result = await original.call(this, value);
    await hold('written', location);
    return result;
  });
  wrap(FileSystemWritableFileStream.prototype, 'close', (original) => async function (...args) {
    const result = await original.apply(this, args);
    await hold('closed', streams.get(this) ?? 'unknown OPFS file');
    return result;
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
    const summary = { opfsFiles: 0, opfsBytes: 0, idbRecords: 0, vanishedEntries: 0, retriedReads: 0, vaultBackends: [], interruptedRecords: [] };
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
            if (window.__opfsInterruption && location.startsWith('/artipod-vault/') && name.startsWith('.artipod-stage-v1-')) {
              const data = new Uint8Array(bytes);
              const encrypted = new TextDecoder().decode(data.slice(0, 8)) === 'APODENC1';
              summary.interruptedRecords.push({ id: name, length: data.length, header: encrypted ? 'APODENC1' : data.length ? 'not-envelope' : 'empty' });
            }
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
              if (name === 'control' && cursor.value?.encryptionRequired === true) summary.vaultBackends.push(cursor.value.backend);
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
  const { vaultBackends } = await page.evaluate(() => window.__inspectRawPersistence());
  assert.deepEqual(vaultBackends, [backend], 'The browser did not use the explicitly requested persistent backend');
}

async function save() {
  await page.evaluate(async () => {
    if (typeof window.__artipodSave !== 'function') throw new Error('The host save completion boundary is unavailable');
    await window.__artipodSave();
  });
}

async function savedMetadata(workspace = names.workspace) {
  return page.evaluate(async ({ workspace }) => {
    const p = window.__artipod.zfs.promises;
    const registry = JSON.parse(await p.readFile('/.artipod/ui-state.json', 'utf8'));
    // lastOpened changes when the workspace reopens; all durable identity and
    // status fields must remain exact. The actor is private and stays in-page.
    const entry = registry.workspaces.find(entry => entry.id === workspace);
    const { lastOpened, ...metadata } = entry ?? {};
    if (!lastOpened) throw new Error('Saved registry entry is missing');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('artipod-keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let grant;
    try {
      grant = await new Promise((resolve, reject) => {
        const request = db.transaction('device').objectStore('device').get('session');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
    if (!grant) throw new Error('The device-wrapped offline grant was not saved');
    // Compare opaque grant fingerprints, never serialize grant/key material to
    // the report. The synthetic registry is safe to compare in this process.
    const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { metadata, grantDigest: await digest(grant), actorDigest: await digest(registry.actor) };
  }, { workspace });
}

async function readyAfterUnlock() {
  // A background registry write may have been in flight when the lease was
  // revoked. Renewing the key cannot repair a failed persistence queue; take
  // the visible recovery action explicitly before checking saved bytes/drafts.
  await page.waitForFunction(() => (!!window.__artipod && !document.querySelector('[aria-label="Browser storage access"]')) ||
    [...document.querySelectorAll('button')].some(button => button.textContent.trim() === 'Recover saved storage'));
  const recover = page.getByRole('button', { name: 'Recover saved storage', exact: true });
  if (await recover.isVisible()) await recover.click();
  await ready();
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
      const filenames = await p.readdir(`${root}/${names.directory}`);
      if (JSON.stringify(filenames.sort()) !== JSON.stringify([names.filename, names.target, 'link'].sort())) throw new Error('Persisted filenames changed');
    }
    const snapshots = await pod.snapshots.list();
    if (!snapshots.some((snapshot) => snapshot.label === names.label)) throw new Error('Snapshot label did not survive');
  }, { names, ref });
}

async function seed() {
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
}

try {
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  context = await browser.newContext();
  context.setDefaultTimeout(stepTimeout);
  await context.exposeBinding('__reportPersistence', (_, event) => { events.push(event); });
  await context.addInitScript(observePersistence, { markers: Object.values(names), canary, backend });
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
    await seed();
    await audit('scratch and snapshot');
  });
  await step('reload recovers exact scratch files and snapshot', async () => {
    await save();
    const metadata = await savedMetadata();
    await save();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    await checkFiles();
    assert.deepEqual(await savedMetadata(), metadata, 'Saved registry metadata or wrapped grant changed after reload');
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
    // The preference writer and debounced registry probe overlap. This is the
    // host's actual completion boundary; logical state plus a filesystem drain
    // did not include future service writes in the original #129 failure.
    await save();
    const metadata = await savedMetadata();
    const settings = await page.evaluate(() => window.__artipod.zfs.promises.readFile('/.artipod/oci/settings.json', 'utf8'));
    assert.equal(JSON.parse(settings).offline, true, 'Save completed before the preference became durable');
    await save();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    await checkFiles();
    assert.equal(await page.evaluate(() => window.__artipod.zfs.promises.readFile('/.artipod/oci/settings.json', 'utf8')), settings, 'Exact saved preference changed on reload');
    assert.deepEqual(await savedMetadata(), metadata, 'Offline reload changed saved registry metadata or the wrapped grant');
    await page.getByRole('button', { name: 'offline (forced)', exact: true }).click();
    await save();
    await audit('offline reload');
  });
  if (backend === 'opfs') for (const operation of ['created', 'written', 'closed']) await step(`interrupt overlapping preference and registry saves after OPFS ${operation}`, async () => {
    const original = page;
    const isolated = await browser.newContext();
    isolated.setDefaultTimeout(stepTimeout);
    await isolated.exposeBinding('__reportPersistence', (_, event) => { events.push(event); });
    await isolated.addInitScript(observePersistence, { markers: Object.values(names), canary, backend });
    try {
      page = await isolated.newPage();
      page.on('pageerror', error => diagnostics.push(`pageerror: ${error.message}`));
      const url = new URL(base);
      url.searchParams.set('artipod', names.workspace);
      await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      await ready();
      await seed();
      await save();
      await page.getByRole('button', { name: 'online', exact: true }).click();
      await save();
      await page.getByRole('button', { name: 'offline (forced)', exact: true }).click();
      await save();
      const metadata = await savedMetadata();
      const settings = await page.evaluate(() => window.__artipod.zfs.promises.readFile('/.artipod/oci/settings.json', 'utf8'));
      await save();
      await page.evaluate(operation => window.__armOpfsInterruption(operation), operation);
      // Queue both real producers before entering the host completion boundary.
      await page.getByRole('button', { name: 'online', exact: true }).click();
      await page.evaluate(() => {
        window.__artipod.events.emit('fs:changed', { origin: 'exec' });
        window.__interruptedSaveCompleted = false;
        window.__interruptedSave = window.__artipodSave().then(() => { window.__interruptedSaveCompleted = true; }, () => {});
      });
      await page.waitForFunction(() => !!window.__opfsInterruption);
      assert.equal(await page.evaluate(() => window.__interruptedSaveCompleted), false, 'Save completion resolved while native persistence was held');
      const interrupted = await page.evaluate(() => window.__inspectRawPersistence());
      assert(interrupted.interruptedRecords.length > 0, 'The deterministic native interruption did not leave observable stage evidence');
      const record = interrupted.interruptedRecords.find(record => !record.id.endsWith('.crswap'));
      assert.equal(record.length > 0, operation === 'closed', 'The held native operation did not match its raw ciphertext boundary');
      reports.push({ stage: `overlapping host saves interrupted after ${operation}`, backend, interruptedRecords: interrupted.interruptedRecords });
      await page.close();
      page = await isolated.newPage();
      await page.goto(url.href, { waitUntil: 'domcontentloaded' });
      await ready();
      await page.getByRole('alert').filter({ hasText: /interrupted.*write|unfinished.*write|interrupted.*storage/i }).waitFor();
      if (operation === 'created' && process.env.RECOVERY_SCREENSHOT_PATH) {
        const banner = page.getByRole('alert').filter({ hasText: /interrupted record write/ });
        reports.push({ stage: 'dark mode recovery warning', colors: await banner.evaluate(element => {
          const style = getComputedStyle(element);
          return { foreground: style.color, background: style.backgroundColor, dark: document.documentElement.classList.contains('dark') };
        }) });
        await page.screenshot({ path: resolve(process.env.RECOVERY_SCREENSHOT_PATH), fullPage: true });
      }
      await checkFiles();
      assert.deepEqual(await savedMetadata(), metadata, 'Interrupted host save changed saved registry metadata or the wrapped grant');
      assert.equal(await page.evaluate(() => window.__artipod.zfs.promises.readFile('/.artipod/oci/settings.json', 'utf8')), settings, 'Interrupted host save changed the last saved preference');
      await save();
      await page.getByRole('button', { name: 'online', exact: true }).waitFor();
      await audit(`reopened saved generation after OPFS ${operation}`);
    } finally { await isolated.close(); page = original; }
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
    await readyAfterUnlock();
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
    await readyAfterUnlock();
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
  await step('recover a failed write while the broker lease stays valid without losing drafts', async () => {
    const draft = `${names.editorDraft}-quota-recovery`;
    const editable = page.locator('.ProseMirror[contenteditable="true"]:visible').first();
    const saved = await page.evaluate(async (names) => window.__artipod.zfs.promises.readFile(`/work/${names.workspace}/${names.editorFile}`, 'utf8'), names);
    await editable.fill(draft);
    await page.getByLabel('Unsaved changes', { exact: true }).waitFor();
    let logins = 0;
    const loginRequest = request => { if (new URL(request.url()).pathname === '/api/keys/login') logins++; };
    page.on('request', loginRequest);
    try {
      const result = await page.evaluate(async (names) => {
        const encrypt = SubtleCrypto.prototype.encrypt;
        SubtleCrypto.prototype.encrypt = async () => { throw new DOMException('Synthetic storage quota failure', 'QuotaExceededError'); };
        try {
          await window.__artipod.zfs.promises.writeFile(`/work/${names.workspace}/${names.editorFile}`, names.editorSaved);
          return { saved: true };
        } catch (error) { return { saved: false, error: error.message }; }
        finally { SubtleCrypto.prototype.encrypt = encrypt; }
      }, names);
      assert.equal(result.saved, false, 'Injected quota failure was reported as saved');
      await page.getByRole('heading', { name: 'Browser storage could not open', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Release the key lease', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Recover saved storage', exact: true }).click();
      await ready();
      await page.getByRole('alert').filter({ hasText: 'Storage reopened from its saved generation after a failed write.' }).waitFor();
      await page.getByLabel('Unsaved changes', { exact: true }).waitFor();
      await page.waitForFunction(draft => document.querySelector('.ProseMirror[contenteditable="true"]')?.textContent === draft, draft);
      assert.equal(await page.evaluate(async (names) => window.__artipod.zfs.promises.readFile(`/work/${names.workspace}/${names.editorFile}`, 'utf8'), names), saved, 'Recovery changed saved bytes or silently saved the draft');
      assert.equal(logins, 0, 'Recovery of an I/O failure required a new broker login');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByLabel('Unsaved changes', { exact: true }).waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(async (names) => window.__artipod.zfs.promises.readFile(`/work/${names.workspace}/${names.editorFile}`, 'utf8'), names), `${draft}\n`, 'The recovered draft could not be explicitly saved');
      await audit('quota failure recovery with a valid broker lease');
    } finally { page.off('request', loginRequest); }
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
  await step('save waits for scheduled RW push and its registry updates', async () => {
    await save();
    await page.evaluate(async names => {
      const pod = window.__artipod;
      const push = pod.pushBasis.bind(pod);
      let resume;
      const gate = new Promise(resolve => { resume = resolve; });
      window.__resumeQueuedPush = () => { pod.pushBasis = push; resume(); };
      pod.pushBasis = async (...args) => {
        window.__queuedPushHeld = true;
        await gate;
        return push(...args);
      };
      await pod.zfs.promises.writeFile(`${pod.basis.at}/${names.queuedOverlay}`, names.queuedPayload);
      pod.events.emit('fs:changed', { origin: 'exec' });
      window.__queuedSaveCompleted = false;
      window.__queuedSave = window.__artipodSave().then(() => { window.__queuedSaveCompleted = true; });
    }, names);
    try {
      await page.waitForFunction(() => window.__queuedPushHeld === true);
      assert.equal(await page.evaluate(() => window.__queuedSaveCompleted), false, 'Save completed before the queued RW push settled');
    } finally { await page.evaluate(() => window.__resumeQueuedPush()); }
    await page.evaluate(() => window.__queuedSave);
    const metadata = await savedMetadata(names.ref);
    assert.equal(metadata.metadata.unsynced, false, 'Save completed before the push outcome reached the registry');
    await audit('scheduled push save completion');
  });
  await step('reload ref, hydrate published files, and recover overlay contents', async () => {
    await save();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(names.ref);
    await checkFiles(names.ref);
    const text = await page.evaluate(async (names) => window.__artipod.zfs.promises.readFile(`${window.__artipod.basis.at}/${names.overlay}`, 'utf8'), names);
    assert.equal(text, names.payload, 'Published overlay did not survive reload');
    assert.equal(await page.evaluate(async names => window.__artipod.zfs.promises.readFile(`${window.__artipod.basis.at}/${names.queuedOverlay}`, 'utf8'), names), names.queuedPayload, 'The scheduled push save did not survive reload');
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
    await volatile.addInitScript(observePersistence, { markers: Object.values(names), canary, backend });
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
  process.stdout.write(`${JSON.stringify({ result: 'passed', backend, browser: browser.version(), checks: reports, observedCanaryWrites: events.filter((event) => event.canary).length, plaintextLeaks: 0, unhandledBrowserErrors: 0 }, null, 2)}\n`);
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
