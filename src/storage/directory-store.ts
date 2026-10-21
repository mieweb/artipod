/** Numeric store records inside an existing filesystem (including an encrypted root). */
import type { AsyncMap, CreationOptions, InodeLike, Store, Transaction } from '@zenfs/core';
import type { ZenFsLike } from '../sandbox/types.js';

export async function directoryStore(options: {
  zfs: ZenFsLike;
  directory: string;
  flush?: () => Promise<void>;
}): Promise<Store & AsyncMap> {
  const { AsyncMapTransaction } = await import('@zenfs/core');
  const p = options.zfs.promises;
  await p.mkdir(options.directory, { recursive: true });
  const ids = new Set<number>();
  for (const name of await p.readdir(options.directory)) {
    if (/^\d+$/.test(String(name))) ids.add(Number(name));
  }
  const recordPath = (id: number) => {
    if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid directory store record');
    return `${options.directory}/${id}`;
  };
  const store: Store & AsyncMap = {
    name: 'directory-store',
    flags: [],
    keys: () => ids,
    cached: () => undefined,
    async get(id) {
      try { return new Uint8Array(await p.readFile(recordPath(id))); }
      catch (error) {
        if ((error as { code?: string }).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    async set(id, data, offset = 0) {
      let bytes = data.slice();
      if (offset !== 0) {
        const previous = await store.get(id) ?? new Uint8Array();
        bytes = new Uint8Array(Math.max(previous.length, offset + data.length));
        bytes.set(previous);
        bytes.set(data, offset);
      }
      await p.writeFile(recordPath(id), bytes);
      ids.add(id);
    },
    async delete(id) {
      try { await p.unlink(recordPath(id)); }
      catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
      ids.delete(id);
    },
    transaction(): Transaction { return new AsyncMapTransaction(store); },
    async sync() { await options.flush?.(); },
  };
  return store;
}

/** Directory view over the supplied global ZenFS instance's underlying mount. */
export async function directoryMount(zfs: ZenFsLike, directory: string): Promise<import('@zenfs/core').FileSystem> {
  const [{ FileSystem }, { resolveMount }] = await Promise.all([
    import('@zenfs/core'),
    import('@zenfs/core/vfs/shared.js'),
  ]);
  await zfs.promises.mkdir(directory, { recursive: true });
  const absolute = await zfs.promises.realpath(directory) as string;
  const { fs: source, path: prefix } = resolveMount(absolute, undefined);
  const path = (value: string) => {
    if (!value.startsWith('/') || value.includes('\0') || value.split('/').some(part => part === '..' || part === '.')) {
      throw new Error('Invalid directory filesystem path');
    }
    return prefix === '/' ? value : value === '/' ? prefix : `${prefix}${value}`;
  };
  // Delegate below the node-like VFS. Passthrough over that VFS follows
  // symlinks in stat(), truncates partial writes, and double-closes handles.
  // Low-level delegation preserves symlink bytes, offsets and inode metadata,
  // while retaining the encrypted source's lease checks and flush behavior.
  class DirectoryFileSystem extends FileSystem {
    constructor() {
      super(source.type, `directory:${source.name}`);
      for (const [key, value] of source.attributes) this.attributes.set(key, value);
    }
    override ready(): Promise<void> { return source.ready(); }
    override usage() { return source.usage(); }
    rename(from: string, to: string): Promise<void> { return source.rename(path(from), path(to)); }
    renameSync(from: string, to: string): void { source.renameSync(path(from), path(to)); }
    stat(name: string): Promise<InodeLike> { return source.stat(path(name)); }
    statSync(name: string): InodeLike { return source.statSync(path(name)); }
    touch(name: string, metadata: Partial<InodeLike>): Promise<void> { return source.touch(path(name), metadata); }
    touchSync(name: string, metadata: Partial<InodeLike>): void { source.touchSync(path(name), metadata); }
    createFile(name: string, options: CreationOptions): Promise<InodeLike> { return source.createFile(path(name), options); }
    createFileSync(name: string, options: CreationOptions): InodeLike { return source.createFileSync(path(name), options); }
    unlink(name: string): Promise<void> { return source.unlink(path(name)); }
    unlinkSync(name: string): void { source.unlinkSync(path(name)); }
    rmdir(name: string): Promise<void> { return source.rmdir(path(name)); }
    rmdirSync(name: string): void { source.rmdirSync(path(name)); }
    mkdir(name: string, options: CreationOptions): Promise<InodeLike> { return source.mkdir(path(name), options); }
    mkdirSync(name: string, options: CreationOptions): InodeLike { return source.mkdirSync(path(name), options); }
    readdir(name: string): Promise<string[]> { return source.readdir(path(name)); }
    readdirSync(name: string): string[] { return source.readdirSync(path(name)); }
    override exists(name: string): Promise<boolean> { return source.exists(path(name)); }
    override existsSync(name: string): boolean { return source.existsSync(path(name)); }
    link(from: string, to: string): Promise<void> { return source.link(path(from), path(to)); }
    linkSync(from: string, to: string): void { source.linkSync(path(from), path(to)); }
    sync(): Promise<void> { return source.sync(); }
    syncSync(): void { source.syncSync(); }
    read(name: string, bytes: Uint8Array, start: number, end: number): Promise<void> { return source.read(path(name), bytes, start, end); }
    readSync(name: string, bytes: Uint8Array, start: number, end: number): void { source.readSync(path(name), bytes, start, end); }
    write(name: string, bytes: Uint8Array, offset: number): Promise<void> { return source.write(path(name), bytes, offset); }
    writeSync(name: string, bytes: Uint8Array, offset: number): void { source.writeSync(path(name), bytes, offset); }
  }
  return new DirectoryFileSystem();
}
