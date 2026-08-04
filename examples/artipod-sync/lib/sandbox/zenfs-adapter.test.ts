/**
 * IFileSystem contract tests for ZenFsAdapter, mirroring
 * just-bash/src/fs/interface.contract.test.ts plus error-shape checks.
 * Runs over an in-memory ZenFS in Node — same code path as the browser.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { ZenFsAdapter } from './zenfs-adapter';

async function freshAdapter(): Promise<ZenFsAdapter> {
  try {
    umount('/');
  } catch {
    // first run: nothing mounted yet
  }
  await configure({ mounts: { '/': InMemory } });
  return new ZenFsAdapter(zfs);
}

let fs: ZenFsAdapter;

beforeEach(async () => {
  fs = await freshAdapter();
});

describe('ZenFsAdapter IFileSystem contract', () => {
  it('reads, writes, appends, stats, lists, and removes files', async () => {
    await fs.mkdir('/docs', { recursive: true });
    await fs.writeFile('/docs/readme.md', 'hello');
    await fs.appendFile('/docs/readme.md', ' world');

    expect(await fs.readFile('/docs/readme.md')).toBe('hello world');
    expect(await fs.exists('/docs/readme.md')).toBe(true);
    expect((await fs.stat('/docs/readme.md')).isFile).toBe(true);
    expect(await fs.readdir('/docs')).toContain('readme.md');

    await fs.rm('/docs/readme.md');
    expect(await fs.exists('/docs/readme.md')).toBe(false);
  });

  it('copies and moves files without changing file contents', async () => {
    await fs.mkdir('/tmp', { recursive: true });
    await fs.writeFile('/tmp/source.txt', 'contents');
    await fs.cp('/tmp/source.txt', '/tmp/copy.txt');
    await fs.mv('/tmp/copy.txt', '/tmp/moved.txt');

    expect(await fs.readFile('/tmp/source.txt')).toBe('contents');
    expect(await fs.readFile('/tmp/moved.txt')).toBe('contents');
    expect(await fs.exists('/tmp/copy.txt')).toBe(false);
  });

  it('copies directories only when recursive is set', async () => {
    await fs.mkdir('/dir/sub', { recursive: true });
    await fs.writeFile('/dir/sub/f.txt', 'x');

    await expect(fs.cp('/dir', '/dir2')).rejects.toThrow();
    await fs.cp('/dir', '/dir3', { recursive: true });
    expect(await fs.readFile('/dir3/sub/f.txt')).toBe('x');
  });

  it('resolves relative paths consistently', () => {
    expect(fs.resolvePath('/work', 'file.txt')).toBe('/work/file.txt');
    expect(fs.resolvePath('/work', '../file.txt')).toBe('/file.txt');
    expect(fs.resolvePath('/work', '/absolute.txt')).toBe('/absolute.txt');
    expect(fs.resolvePath('/', 'a/./b/../c')).toBe('/a/c');
    expect(fs.resolvePath('/a', '../../..')).toBe('/');
  });

  it('creates symlinks and keeps lstat/stat semantics apart', async () => {
    await fs.writeFile('/target.txt', 'target');
    await fs.symlink('/target.txt', '/link.txt');

    expect(await fs.readlink('/link.txt')).toBe('/target.txt');
    expect((await fs.lstat('/link.txt')).isSymbolicLink).toBe(true);
    expect((await fs.stat('/link.txt')).isFile).toBe(true);
    expect(await fs.readFile('/link.txt')).toBe('target');
    expect(await fs.realpath('/link.txt')).toBe('/target.txt');
  });

  it('creates hard links sharing content', async () => {
    await fs.writeFile('/orig.txt', 'data');
    await fs.link('/orig.txt', '/hard.txt');
    expect(await fs.readFile('/hard.txt')).toBe('data');
  });

  it('supports binary reads and buffer round-trips', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await fs.writeFile('/bin.dat', bytes);
    expect(Array.from(await fs.readFileBuffer('/bin.dat'))).toEqual([0, 1, 2, 250, 255]);
  });

  it('lists directory entries with file types', async () => {
    await fs.mkdir('/d/sub', { recursive: true });
    await fs.writeFile('/d/a.txt', 'A');
    const entries = await fs.readdirWithFileTypes('/d');
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['sub'].isDirectory).toBe(true);
    expect(byName['a.txt'].isFile).toBe(true);
  });

  it('chmod and utimes update metadata', async () => {
    await fs.writeFile('/m.txt', 'm');
    await fs.chmod('/m.txt', 0o755);
    expect((await fs.stat('/m.txt')).mode & 0o777).toBe(0o755);

    const when = new Date('2020-01-02T03:04:05Z');
    await fs.utimes('/m.txt', when, when);
    expect((await fs.stat('/m.txt')).mtime.getTime()).toBe(when.getTime());
  });

  it('exposes stable identity for cp/mv cycle detection', async () => {
    await fs.writeFile('/id.txt', 'x');
    const s = await fs.stat('/id.txt');
    expect(s.identity).toBe(`${s.dev}:${s.ino}`);
  });

  it('rm honors force and recursive flags', async () => {
    await expect(fs.rm('/nope')).rejects.toThrow();
    await expect(fs.rm('/nope', { force: true })).resolves.toBeUndefined();

    await fs.mkdir('/full');
    await fs.writeFile('/full/f.txt', 'f');
    await fs.rm('/full', { recursive: true });
    expect(await fs.exists('/full')).toBe(false);
  });

  it('throws node-shaped errors just-bash can match on', async () => {
    // ENOENT on missing file — message mentions the code, like node
    await expect(fs.readFile('/missing.txt')).rejects.toThrow(/ENOENT/);
    await expect(fs.stat('/missing.txt')).rejects.toThrow(/ENOENT/);
    // EEXIST on mkdir over existing path
    await fs.mkdir('/dup');
    await expect(fs.mkdir('/dup')).rejects.toThrow(/EEXIST/);
  });

  it('getAllPaths degrades gracefully (documented ls-glob edge case)', () => {
    expect(fs.getAllPaths()).toEqual([]);
  });
});
