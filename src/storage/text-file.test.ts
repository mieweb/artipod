import { afterEach, describe, expect, it, vi } from 'vitest';
import { fs as singleton } from '@zenfs/core';
import type { ZenFsLike } from '../sandbox/types.js';
import { configureStorageRoot, createMemoryStorageRoot } from '../sandbox/storage.js';
import { createStorageSession, type StorageSession } from './session.js';
import { readStorageTextFile, writeStorageTextFile } from './text-file.js';

const sessions: StorageSession[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.allSettled(sessions.splice(0).map(session => session.close())); });
const path = '/metadata/settings.json';
const previousPath = '/metadata/.settings.previous';
function missing(): Error { return Object.assign(new Error('Absent'), { code: 'ENOENT' }); }
async function fixture() {
  const session = createStorageSession({ policy: 'memory' });
  sessions.push(session);
  const storage = await session.open();
  return { storage, options: { zfs: storage.zfs, path, previousPath } };
}

describe('recoverable storage text files', () => {
  it.each([
    ['relative', previousPath], [path, path], ['/metadata/../settings.json', previousPath],
    ['/metadata//settings.json', previousPath], ['/metadata/./settings.json', previousPath],
    ['/metadata/settings.json/', previousPath], ['/metadata/settings\\.json', previousPath],
    [path, '/elsewhere/previous'], ['/', '/previous'], ['/metadata/\0settings', previousPath],
  ])('rejects noncanonical or overlapping paths before filesystem I/O (%j, %j)', async (path, previousPath) => {
    const io = vi.fn();
    const zfs = { promises: new Proxy({}, { get: () => io }) } as ZenFsLike;
    await expect(readStorageTextFile({ zfs, path, previousPath })).rejects.toThrow('distinct canonical absolute paths');
    await expect(writeStorageTextFile({ zfs, path, previousPath }, 'new')).rejects.toThrow('distinct canonical absolute paths');
    expect(io).not.toHaveBeenCalled();
  });

  it('uses fallback only for absence and preserves empty text and strict read failures', async () => {
    const readFile = vi.fn(async (name: string) => { if (name === path) throw missing(); return 'previous'; });
    const options = { zfs: { promises: { readFile } } as unknown as ZenFsLike, path, previousPath };
    expect(await readStorageTextFile(options)).toBe('previous');
    readFile.mockImplementation(async () => { throw missing(); });
    expect(await readStorageTextFile(options)).toBeNull();
    readFile.mockResolvedValue('');
    expect(await readStorageTextFile(options)).toBe('');
    const failure = Object.assign(new Error('Read failed'), { code: 'EIO' });
    readFile.mockRejectedValue(failure);
    await expect(readStorageTextFile(options)).rejects.toBe(failure);
  });

  it('uses the inferred context drain instead of a caller-provided flush and rejects stale contexts', async () => {
    const { options, storage } = await fixture();
    const flush = vi.fn(async () => {});
    await writeStorageTextFile({ ...options, flush }, 'saved');
    expect(await readStorageTextFile(options)).toBe('saved');
    expect(flush).not.toHaveBeenCalled();
    await sessions[0].close();
    await expect(readStorageTextFile(options)).rejects.toThrow('core storage context');
    await expect(writeStorageTextFile(options, 'later')).rejects.toThrow('core storage context');
    expect(storage.protection).toBe('volatile');
  });

  it('serializes concurrent replacement and reads without ever overwrite-renaming', async () => {
    const { storage } = await fixture();
    const p = storage.zfs.promises;
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let hold = false;
    const rename = vi.fn(async (from: string, to: string) => {
      expect(await p.exists(to)).toBe(false);
      if (hold && from === path) { hold = false; entered(); await resume; }
      await p.rename(from, to);
    });
    const zfs = { promises: new Proxy(p, { get: (source, name) => name === 'rename' ? rename : Reflect.get(source, name) }) } as ZenFsLike;
    const flush = vi.fn(() => storage.flush());
    const options = { zfs, path, previousPath, flush };
    await writeStorageTextFile(options, '{"revision":0}');
    hold = true;
    const first = writeStorageTextFile(options, '{"revision":1}');
    await paused;
    const second = writeStorageTextFile(options, '{"revision":2}');
    const read = readStorageTextFile(options);
    release();
    await Promise.all([first, second]);
    expect(await read).toBe('{"revision":2}');
    const operations = [];
    for (let revision = 3; revision < 8; revision++) {
      operations.push(writeStorageTextFile(options, JSON.stringify({ revision })));
      operations.push(readStorageTextFile(options).then(text => {
        expect(text).not.toBeNull();
        expect(JSON.parse(text!).revision).toBe(revision);
      }));
    }
    await Promise.all(operations);
    expect(rename.mock.calls.length).toBeGreaterThan(10);
    expect(flush).toHaveBeenCalled();
  });

  it('holds raw singleton ownership through a delayed mkdir so managed acquisition cannot redirect its stage', async () => {
    const root = await createMemoryStorageRoot();
    await configureStorageRoot(root);
    const mkdir = root.mkdir.bind(root);
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(root, 'mkdir').mockImplementationOnce(async (...args) => { entered(); await resume; return mkdir(...args); });
    const options = { zfs: singleton as unknown as ZenFsLike, path, previousPath };
    const writing = writeStorageTextFile(options, 'raw singleton text');
    void writing.catch(() => {});
    await paused;
    const contender = createStorageSession({ policy: 'memory' });
    sessions.push(contender);
    let acquisitionError: unknown;
    try {
      const redirected = await contender.open();
      // Demonstrate the old race's cross-root write if it acquires while mkdir
      // is paused; the fixed operation keeps this contender out entirely.
      await redirected.zfs.promises.mkdir('/metadata', { recursive: true });
    } catch (error) { acquisitionError = error; }
    finally { release(); }
    await writing;
    expect((acquisitionError as Error | undefined)?.message).toMatch(/raw storage operation/);
    expect(await readStorageTextFile(options)).toBe('raw singleton text');
    const current = await fixture();
    expect(await current.storage.zfs.promises.exists(path)).toBe(false);
  });

  it('releases a raw singleton reservation when its staging drain fails', async () => {
    await configureStorageRoot(await createMemoryStorageRoot());
    const failure = new Error('Injected legacy flush failure');
    await expect(writeStorageTextFile({ zfs: singleton as unknown as ZenFsLike, path, previousPath,
      flush: async () => { throw failure; } }, 'staged')).rejects.toBe(failure);
    expect((await fixture()).storage.protection).toBe('volatile');
  });
});
