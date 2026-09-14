import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import { PodEvents, type FsChangedEvent } from '../events.js';
import { sha256 } from '../oci/digest.js';
import { createIngest } from './ingest.js';

const text = (s: string) => new TextEncoder().encode(s);

beforeEach(async () => {
  for (const path of [...zenMounts.keys()]) if (path !== '/') umount(path);
  try {
    umount('/');
  } catch {
    // first run
  }
  await configure({ mounts: { '/': InMemory } });
});

describe('ingest.put', () => {
  it('writes a Blob, creates parents, returns size + digest, emits fs:changed', async () => {
    const events = new PodEvents();
    const seen: FsChangedEvent[] = [];
    events.on('fs:changed', (e) => seen.push(e));
    const ingest = createIngest(zfs, events);

    const blob = new Blob([text('hello '), text('world')], { type: 'text/plain' });
    const res = await ingest.put('/media/notes/a.txt', blob, { mime: 'text/plain' });

    expect(res).toEqual({
      path: '/media/notes/a.txt',
      size: 11,
      digest: await sha256(text('hello world')),
      mime: 'text/plain',
    });
    expect(await zfs.promises.readFile('/media/notes/a.txt', 'utf8')).toBe('hello world');
    expect(seen).toEqual([{ paths: ['/media/notes/a.txt'], origin: 'ingest' }]);
  });

  it('accepts bytes and strings; rejects relative paths', async () => {
    const ingest = createIngest(zfs);
    await ingest.put('/a.bin', new Uint8Array([1, 2, 3]));
    await ingest.put('/b.txt', 'x');
    expect([...(await zfs.promises.readFile('/a.bin'))]).toEqual([1, 2, 3]);
    expect(await zfs.promises.readFile('/b.txt', 'utf8')).toBe('x');
    await expect(ingest.put('rel.txt', 'x')).rejects.toThrow(/absolute/);
  });
});

describe('ingest.open', () => {
  it('appends chunks incrementally (readable while open) and seals on close', async () => {
    const events = new PodEvents();
    const seen: FsChangedEvent[] = [];
    events.on('fs:changed', (e) => seen.push(e));
    const ingest = createIngest(zfs, events);

    const w = ingest.open('/inbox/visit.webm', { mime: 'video/webm' });
    await w.append(text('abc'));
    await w.append(new Blob([text('def')]));
    expect(w.size).toBe(6);
    // partial content is on disk before close (crash safety)
    expect(await zfs.promises.readFile('/inbox/visit.webm', 'utf8')).toBe('abcdef');
    expect(seen).toEqual([]);

    const res = await w.close();
    expect(res).toEqual({
      path: '/inbox/visit.webm',
      size: 6,
      digest: await sha256(text('abcdef')),
      mime: 'video/webm',
    });
    expect(seen).toEqual([{ paths: ['/inbox/visit.webm'], origin: 'ingest' }]);
    await expect(w.append(text('x'))).rejects.toThrow(/closed/);
  });

  it('serializes un-awaited appends in order', async () => {
    const ingest = createIngest(zfs);
    const w = ingest.open('/seq.txt');
    void w.append(text('1'));
    void w.append(text('2'));
    void w.append(text('3'));
    const res = await w.close();
    expect(res.size).toBe(3);
    expect(await zfs.promises.readFile('/seq.txt', 'utf8')).toBe('123');
  });

  it('abort removes the partial file', async () => {
    const ingest = createIngest(zfs);
    const w = ingest.open('/tmp/partial.bin');
    await w.append(new Uint8Array(16));
    expect(await zfs.promises.stat('/tmp/partial.bin')).toBeTruthy();
    await w.abort();
    await expect(zfs.promises.stat('/tmp/partial.bin')).rejects.toThrow();
  });

  it('abort before any append is a no-op', async () => {
    const ingest = createIngest(zfs);
    await ingest.open('/never.bin').abort();
    await expect(zfs.promises.stat('/never.bin')).rejects.toThrow();
  });
});
