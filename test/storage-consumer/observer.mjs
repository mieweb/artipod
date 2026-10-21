/** Installed before the packed consumer bundle runs in a fresh browser page. */
export function observePersistence({ markers, canary }) {
  const pending = new Set();
  const events = [];
  const handles = new WeakMap();
  const streams = new WeakMap();
  const forms = value => [...new Set([
    value, encodeURIComponent(value), encodeURIComponent(encodeURIComponent(value)),
    JSON.stringify(value).slice(1, -1), btoa(value),
    [...value].map(character => character.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    [...value].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
  ])];
  const needles = [...markers, canary].map(marker => ({ marker, variants: forms(marker) }));
  function track(promise) {
    const task = Promise.resolve(promise).finally(() => pending.delete(task));
    pending.add(task);
    return task;
  }
  function text(value, operation, location) {
    for (const needle of needles) if (needle.variants.some(form => value.includes(form))) events.push({ operation, location, marker: needle.marker, canary: needle.marker === canary });
  }
  function inspect(value, operation, location, seen = new WeakSet()) {
    if (typeof value === 'string') { text(value, operation, location); return; }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value).slice() : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      text(new TextDecoder().decode(bytes), operation, location);
      text(new TextDecoder('utf-16le').decode(bytes), operation, location);
    } else if (value instanceof Blob) {
      track(value.arrayBuffer().then(bytes => inspect(bytes, operation, location)));
    } else if (!(value instanceof CryptoKey)) for (const [key, item] of Object.entries(value)) {
      text(key, operation, location);
      inspect(item, operation, location, seen);
    }
  }
  function wrap(prototype, name, make) {
    const original = prototype?.[name];
    if (typeof original === 'function') prototype[name] = make(original);
  }
  for (const method of ['getDirectoryHandle', 'getFileHandle']) wrap(FileSystemDirectoryHandle.prototype, method, original => async function(name, options) {
    const location = `${handles.get(this) ?? ''}/${name}`;
    text(location, 'opfs-name', location);
    const handle = await original.call(this, name, options);
    handles.set(handle, location);
    return handle;
  });
  wrap(FileSystemFileHandle.prototype, 'createWritable', original => async function(...args) {
    const stream = await original.apply(this, args);
    streams.set(stream, handles.get(this) ?? this.name);
    return stream;
  });
  wrap(FileSystemWritableFileStream.prototype, 'write', original => function(value) {
    inspect(value, 'opfs-write', streams.get(this) ?? 'unknown');
    return original.call(this, value);
  });
  wrap(FileSystemWritableFileStream.prototype, 'getWriter', original => function(...args) {
    const writer = original.apply(this, args);
    const write = writer.write.bind(writer);
    const location = streams.get(this) ?? 'unknown';
    writer.write = value => { inspect(value, 'opfs-writer-write', location); return write(value); };
    return writer;
  });
  for (const method of ['put', 'add']) wrap(IDBObjectStore.prototype, method, original => function(value, key) {
    const location = `${this.transaction.db.name}/${this.name}`;
    inspect(value, 'idb-write', location);
    inspect(key, 'idb-key', location);
    return key === undefined ? original.call(this, value) : original.call(this, value, key);
  });
  wrap(IDBFactory.prototype, 'open', original => function(name, ...args) {
    text(name, 'idb-database-name', name);
    return original.call(this, name, ...args);
  });
  wrap(IDBDatabase.prototype, 'createObjectStore', original => function(name, ...args) {
    text(name, 'idb-store-name', `${this.name}/${name}`);
    return original.call(this, name, ...args);
  });
  wrap(Storage.prototype, 'setItem', original => function(key, value) {
    inspect(key, 'web-storage-key', key);
    inspect(value, 'web-storage-write', key);
    return original.call(this, key, value);
  });
  const drain = async () => { while (pending.size) await Promise.all([...pending]); };
  globalThis.persistenceObserver = {
    async events() { await drain(); return events.slice(); },
    async canary() {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle('observer-canary', { create: true });
      const stream = await file.createWritable();
      const writer = stream.getWriter();
      await writer.write(canary);
      await writer.close();
      await root.removeEntry('observer-canary');
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('observer-canary', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('records');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('records', 'readwrite');
        tx.objectStore('records').put(canary, canary);
        tx.oncomplete = resolve;
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
      db.close();
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase('observer-canary');
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
      });
      localStorage.setItem('observer-canary', canary);
      localStorage.removeItem('observer-canary');
      await drain();
      return events.filter(event => event.canary);
    },
    async scan() {
      const summary = { opfsFiles: 0, idbRecords: 0, encryptedBlocks: 0 };
      const checkBlock = bytes => {
        if (!globalThis.storageConsumer.isEncryptedBlob(new Uint8Array(bytes))) throw new Error('Raw generation contains a non-ciphertext block');
        summary.encryptedBlocks++;
      };
      async function walk(directory, parent = '') {
        for await (const [name, handle] of directory.entries()) {
          const location = `${parent}/${name}`;
          text(location, 'raw-opfs-name', location);
          if (handle.kind === 'directory') await walk(handle, location);
          else {
            let bytes;
            for (let attempt = 0; ; attempt++) {
              try { bytes = await (await handle.getFile()).arrayBuffer(); break; }
              catch (error) { if (error.name !== 'NotReadableError' || attempt >= 4) throw error; }
            }
            inspect(bytes, 'raw-opfs-bytes', location);
            if (location.startsWith('/artipod-vault/')) {
              if (!/^\d+$/.test(name)) throw new Error('OPFS generation exposed a logical filename');
              checkBlock(bytes);
            }
            summary.opfsFiles++;
          }
        }
      }
      await walk(await navigator.storage.getDirectory());
      for (const database of await indexedDB.databases()) {
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
                if (db.name.startsWith('artipod-vault-blocks-')) {
                  if (typeof cursor.key !== 'number') { reject(new Error('IDB block key is not numeric')); return; }
                  try { checkBlock(cursor.value); } catch (error) { reject(error); return; }
                }
                summary.idbRecords++;
                cursor.continue();
              };
            });
          }
        } finally { db.close(); }
      }
      for (const storage of [localStorage, sessionStorage]) for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        inspect(key, 'raw-web-storage-key', key);
        inspect(storage.getItem(key), 'raw-web-storage-value', key);
      }
      await drain();
      return { ...summary, leaks: events.filter(event => !event.canary), canaries: events.filter(event => event.canary).length };
    },
  };
}
