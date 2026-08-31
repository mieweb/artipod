/**
 * /host controller tests over a real sandbox (ZenFS InMemory) with a fake
 * xterm-shaped IO — the Phase 2 acceptance wiring, headless:
 * tree invalidates after every command, editor detects external changes,
 * agent echo arrives via agent:tool-call (no registerWriter).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { PodEvents } from '../events.js';
import { createSandbox, type Sandbox } from '../sandbox/index.js';
import { FileBuffer } from './file-buffer.js';
import { TerminalSession, commonPrefix, toCrLf } from './terminal-session.js';
import { TREE_ROOT_ID, TreeSource } from './tree-source.js';

let sandbox: Sandbox;
let events: PodEvents;

class FakeIO {
  out = '';
  write(text: string): void {
    this.out += text;
  }
}

beforeEach(async () => {
  try {
    umount('/');
  } catch {
    // first run
  }
  await configure({ mounts: { '/': InMemory } });
  await zfs.promises.mkdir('/repo');
  events = new PodEvents();
  sandbox = createSandbox({ zfs, events });
});

describe('TerminalSession', () => {
  it('runs a typed command line and writes CRLF output after the prompt', async () => {
    const io = new FakeIO();
    const session = new TerminalSession({ sandbox, io, banner: ['hello banner'] });
    expect(io.out).toContain('hello banner\r\n');
    expect(io.out).toContain('/repo $ ');

    for (const ch of 'echo hi') await session.handleData(ch);
    await session.handleData('\r');
    expect(io.out).toContain('hi\r\n');
    session.dispose();
  });

  it('recalls history with arrow keys and completes with Tab', async () => {
    const io = new FakeIO();
    const session = new TerminalSession({ sandbox, io });
    for (const ch of 'echo one') await session.handleData(ch);
    await session.handleData('\r');

    io.out = '';
    await session.handleData('\x1b[A'); // up
    expect(io.out).toContain('echo one');

    // Tab completion: unique command prefix
    await session.handleData('\x1b[B'); // down → empty line
    for (const ch of 'ech') await session.handleData(ch);
    await session.handleData('\t');
    expect(io.out).toContain('echo ');
    session.dispose();
  });

  it('echoes agent tool calls via agent:tool-call (no registerWriter)', () => {
    const io = new FakeIO();
    const session = new TerminalSession({ sandbox, io, events });
    events.emit('agent:tool-call', { phase: 'call', name: 'bash', arguments: '{"command":"ls"}' });
    expect(io.out).toContain('⚙ bash');
    expect(io.out).toContain('"command":"ls"');
    session.dispose();
    io.out = '';
    events.emit('agent:tool-call', { phase: 'call', name: 'bash', arguments: '{}' });
    expect(io.out).toBe(''); // disposed sessions detach their listeners
  });

  it('refuses commands in read-only sessions', async () => {
    const io = new FakeIO();
    const session = new TerminalSession({ sandbox, io, readOnly: true });
    for (const ch of 'echo nope') await session.handleData(ch);
    await session.handleData('\r');
    expect(io.out).toContain('read-only session');
    expect(io.out).not.toContain('\r\nnope\r\n'); // the command never ran
    session.dispose();
  });

  it('helpers: toCrLf and commonPrefix', () => {
    expect(toCrLf('a\nb\r\nc')).toBe('a\r\nb\r\nc');
    expect(commonPrefix(['foobar', 'foobaz', 'foo'])).toBe('foo');
  });
});

describe('FileBuffer', () => {
  it('opens, edits, saves, and reports dirty state', async () => {
    await zfs.promises.writeFile('/repo/a.md', 'one');
    const buffer = await FileBuffer.open({ zfs, path: '/repo/a.md', events });
    expect(buffer.content).toBe('one');
    expect(buffer.isDirty).toBe(false);
    expect(buffer.language).toBe('markdown');

    buffer.setContent('two');
    expect(buffer.isDirty).toBe(true);
    await buffer.save();
    expect(buffer.isDirty).toBe(false);
    expect(await zfs.promises.readFile('/repo/a.md', 'utf8')).toBe('two');
    buffer.dispose();
  });

  it('detects external changes: reloads when clean', async () => {
    await zfs.promises.writeFile('/repo/b.txt', 'v1');
    const buffer = await FileBuffer.open({ zfs, path: '/repo/b.txt', events });

    // a shell command rewrites the file → coarse fs:changed fires
    await sandbox.exec('echo v2 > /repo/b.txt');
    await new Promise((r) => setTimeout(r, 10)); // async reload settles
    expect(buffer.content).toBe('v2\n');
    expect(buffer.isDirty).toBe(false);
    buffer.dispose();
  });

  it('flags external changes without clobbering a dirty buffer', async () => {
    await zfs.promises.writeFile('/repo/c.txt', 'v1');
    const buffer = await FileBuffer.open({ zfs, path: '/repo/c.txt', events });
    buffer.setContent('my unsaved edit');

    await sandbox.exec('echo surprise > /repo/c.txt');
    await new Promise((r) => setTimeout(r, 10));
    expect(buffer.content).toBe('my unsaved edit'); // preserved
    expect(buffer.externallyChanged).toBe(true);
    buffer.dispose();
  });

  it('save emits a precise fs:changed the buffer itself ignores', async () => {
    const paths: (string[] | undefined)[] = [];
    events.on('fs:changed', (e) => paths.push(e.paths));
    const buffer = await FileBuffer.open({ zfs, path: '/repo/d.txt', events });
    buffer.setContent('data');
    await buffer.save();
    expect(paths).toContainEqual(['/repo/d.txt']);
    expect(buffer.isDirty).toBe(false);
    buffer.dispose();
  });

  it('refuses to save in read-only sessions', async () => {
    const buffer = await FileBuffer.open({ zfs, path: '/repo/e.txt', readOnly: true });
    buffer.setContent('x');
    await expect(buffer.save()).rejects.toThrow(/read-only/);
    buffer.dispose();
  });
});

describe('TreeSource', () => {
  it('serves roots from options and lists children sorted', async () => {
    await zfs.promises.writeFile('/repo/z.txt', 'z');
    await zfs.promises.mkdir('/repo/sub');
    const tree = new TreeSource({ zfs, roots: ['/repo'], events });

    const root = await tree.getItem(TREE_ROOT_ID);
    expect(root.children).toEqual(['/repo']);

    const repo = await tree.getItem('/repo');
    expect(repo.isFolder).toBe(true);
    expect(repo.children).toEqual(['/repo/sub', '/repo/z.txt']);

    const file = await tree.getItem('/repo/z.txt');
    expect(file.isFolder).toBe(false);
    expect(file.data).toBe('z.txt');
    tree.dispose();
  });

  it('auto-invalidates every known id after each shell command', async () => {
    const tree = new TreeSource({ zfs, roots: ['/repo'], events });
    await tree.getItem(TREE_ROOT_ID);
    await tree.getItem('/repo');

    const invalidations: string[][] = [];
    tree.onDidChange((ids) => invalidations.push(ids));

    await sandbox.exec('touch /repo/new-file.txt');
    expect(invalidations.length).toBeGreaterThan(0);
    expect(invalidations[0]).toContain('/repo');
    expect(invalidations[0]).toContain(TREE_ROOT_ID);

    // the re-fetch sees the new file
    const repo = await tree.getItem('/repo');
    expect(repo.children).toContain('/repo/new-file.txt');
    tree.dispose();
  });
});

describe('sandbox events', () => {
  it('emits exec:start/exec:end and coarse fs:changed per live command', async () => {
    const seen: string[] = [];
    events.on('exec:start', (e) => seen.push(`start:${e.line}`));
    events.on('exec:end', (e) => seen.push(`end:${e.line}:${e.exitCode}`));
    events.on('fs:changed', (e) => seen.push(`fs:${e.origin}`));

    await sandbox.exec('true');
    expect(seen).toEqual(['start:true', 'end:true:0', 'fs:exec']);

    // transient execs (tab completion) stay silent
    seen.length = 0;
    await sandbox.complete('ech');
    expect(seen).toEqual([]);
  });

  it('emits edit:request from the edit command', async () => {
    const requested: string[] = [];
    events.on('edit:request', (e) => requested.push(e.path));
    const r = await sandbox.exec('edit notes.md');
    expect(r.exitCode).toBe(0);
    expect(requested).toEqual(['/repo/notes.md']);
  });
});
