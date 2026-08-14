/**
 * The one provider artipod-sync ships itself: a snapshot of the raw browser
 * storage under `/proc/storage`.
 *
 * This is how the *backing devices* are inspected without mounting them into
 * the very filesystem they back — a snapshot cannot recurse into itself. IDB
 * database names containing `/` (Yjs rooms are named that way) become
 * subdirectories, so `ls /proc/storage/idb/case` enumerates case docs.
 *
 * Metadata only. Dumping records is a targeted operation, not something every
 * refresh should pay for.
 */
import { getProvider, registerProcProvider, type ProcProvider, type ProcTree } from './registry';
import { getStorageUsage, OPFS_FS_DIR } from '../sandbox/storage';

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export const storageProvider: ProcProvider = {
  name: 'storage',
  description: 'raw browser storage: IndexedDB databases and the OPFS tree',
  version: '1',
  mode: 'ro',
  async read(): Promise<ProcTree> {
    const tree: ProcTree = {};
    const usage = await getStorageUsage();
    if (usage) tree['origin.json'] = json(usage);
    for (const [name, info] of Object.entries(await probeIndexedDb())) {
      tree[`idb/${name}.json`] = json(info);
    }
    tree['opfs.json'] = json(await probeOpfs());
    return tree;
  },
};

/** Idempotent — the sandbox calls it on every `createSandbox({ proc: true })`. */
export function registerBuiltinProviders(): void {
  if (!getProvider(storageProvider.name)) registerProcProvider(storageProvider);
}

interface IdbInfo {
  database: string;
  version: number | null;
  stores: { name: string; records: number | null }[];
}

async function probeIndexedDb(): Promise<Record<string, IdbInfo>> {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return {};
  const out: Record<string, IdbInfo> = {};
  for (const { name } of await indexedDB.databases()) {
    if (!name) continue;
    out[name] = await describeDatabase(name);
  }
  return out;
}

function describeDatabase(name: string): Promise<IdbInfo> {
  return new Promise<IdbInfo>((resolve) => {
    const request = indexedDB.open(name);
    request.onerror = () => resolve({ database: name, version: null, stores: [] });
    request.onsuccess = async () => {
      const db = request.result;
      const stores = [...db.objectStoreNames];
      const counted = await Promise.all(stores.map((store) => countRecords(db, store)));
      resolve({
        database: name,
        version: db.version,
        stores: stores.map((store, i) => ({ name: store, records: counted[i] })),
      });
      db.close();
    };
  });
}

function countRecords(db: IDBDatabase, store: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const request = db.transaction(store, 'readonly').objectStore(store).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

interface OpfsEntry {
  path: string;
  kind: 'file' | 'directory';
  size: number | null;
}

async function probeOpfs(): Promise<{ available: boolean; entries: OpfsEntry[] }> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return { available: false, entries: [] };
  }
  try {
    const root = await navigator.storage.getDirectory();
    return { available: true, entries: await listTree(root, '') };
  } catch {
    return { available: false, entries: [] };
  }
}

/** The sandbox subtree is already browsable as `/`; only its shape is listed. */
async function listTree(dir: FileSystemDirectoryHandle, prefix: string): Promise<OpfsEntry[]> {
  const out: OpfsEntry[] = [];
  const iterator = (
    dir as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }
  ).entries();
  while (true) {
    const { done, value } = await iterator.next();
    if (done) break;
    const [name, handle] = value;
    const path = `${prefix}${name}`;
    if (handle.kind === 'file') {
      out.push({ path, kind: 'file', size: (await (handle as FileSystemFileHandle).getFile()).size });
      continue;
    }
    out.push({ path, kind: 'directory', size: null });
    if (name !== OPFS_FS_DIR) {
      out.push(...(await listTree(handle as FileSystemDirectoryHandle, `${path}/`)));
    }
  }
  return out;
}
