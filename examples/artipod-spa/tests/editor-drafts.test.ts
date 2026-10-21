import { describe, expect, it, vi } from 'vitest';
import { FileBuffer } from '../../../src/host/file-buffer';
import type { ZenFsLike } from '@artipod/core/sandbox';
import { MemoryEditorDrafts, type EditorDraftSnapshot } from '../lib/services/editor-drafts';

function storage(initial = 'saved text') {
  let locked = false;
  let content = initial;
  const readFile = vi.fn(async () => {
    if (locked) throw Object.assign(new Error('locked'), { code: 'EACCES' });
    return content;
  });
  const writeFile = vi.fn(async (_path: string, text: string) => {
    if (locked) throw Object.assign(new Error('locked'), { code: 'EACCES' });
    content = text;
  });
  return {
    zfs: { promises: { readFile, writeFile } } as unknown as ZenFsLike,
    readFile, writeFile,
    lock: () => { locked = true; },
    unlock: () => { locked = false; },
    disk: () => content,
    externalWrite: (text: string) => { content = text; },
  };
}

describe('memory editor drafts across authenticated UI remounts', () => {
  it('retains dirty text and selection through disposal/lock without touching storage, then saves after unlock', async () => {
    const drafts = new MemoryEditorDrafts();
    const disk = storage();
    const first = await FileBuffer.open({ zfs: disk.zfs, path: '/open/ref/note.txt' });
    const detach = drafts.attach('ref:a:_1', first.path, first, () => {});
    first.setContent('unsaved private draft');
    disk.lock();
    const reads = disk.readFile.mock.calls.length;
    detach();
    first.dispose();
    expect(drafts.selectedFile('ref:a:_1')).toBe('/open/ref/note.txt');
    expect(drafts.read('ref:a:_1', first.path)).toEqual({ content: 'unsaved private draft', savedContent: 'saved text' });
    expect(disk.readFile).toHaveBeenCalledTimes(reads);
    expect(disk.writeFile).not.toHaveBeenCalled();
    expect(disk.disk()).toBe('saved text');

    disk.unlock();
    const restored = await FileBuffer.open({ zfs: disk.zfs, path: first.path });
    const off = drafts.attach('ref:a:_1', restored.path, restored, () => {});
    expect(restored.content).toBe('unsaved private draft');
    expect(restored.isDirty).toBe(true);
    await restored.save();
    expect(drafts.read('ref:a:_1', restored.path)).toBeNull();
    expect(disk.disk()).toBe('unsaved private draft');
    off(); restored.dispose();
  });

  it('does not mix identical paths across refs or different paths in one workspace', async () => {
    const drafts = new MemoryEditorDrafts();
    const disk = storage();
    const first = await FileBuffer.open({ zfs: disk.zfs, path: '/same.txt' });
    const off = drafts.attach('ref:a:_1', first.path, first, () => {});
    first.setContent('only workspace a');
    off(); first.dispose();
    const other = await FileBuffer.open({ zfs: disk.zfs, path: '/same.txt' });
    const offOther = drafts.attach('ref:b:_1', other.path, other, () => {});
    expect(other.content).toBe('saved text');
    expect(other.isDirty).toBe(false);
    expect(drafts.read('ref:a:_1', '/different.txt')).toBeNull();
    expect(drafts.read('ref:a:_1', '/same.txt')?.content).toBe('only workspace a');
    offOther(); other.dispose();
  });

  it('preserves the draft and warns if disk changed while the editor was locked', async () => {
    const drafts = new MemoryEditorDrafts();
    const disk = storage();
    const first = await FileBuffer.open({ zfs: disk.zfs, path: '/note.txt' });
    const off = drafts.attach('scratch:a', first.path, first, () => {});
    first.setContent('my changes');
    off(); first.dispose();
    disk.externalWrite('changed elsewhere');
    const restored = await FileBuffer.open({ zfs: disk.zfs, path: first.path });
    const snapshots: EditorDraftSnapshot[] = [];
    const detach = drafts.attach('scratch:a', restored.path, restored, (snapshot) => snapshots.push(snapshot));
    expect(restored.content).toBe('my changes');
    expect(snapshots.at(-1)).toEqual({ isDirty: true, externallyChanged: true });
    await restored.reload();
    expect(restored.content).toBe('changed elsewhere');
    expect(drafts.read('scratch:a', restored.path)).toBeNull();
    expect(snapshots.at(-1)).toEqual({ isDirty: false, externallyChanged: false });
    detach(); restored.dispose();
  });

  it('keeps drafts when save or reload is denied, and a new page store contains no draft plaintext', async () => {
    const drafts = new MemoryEditorDrafts();
    const disk = storage();
    const buffer = await FileBuffer.open({ zfs: disk.zfs, path: '/note.txt' });
    const off = drafts.attach('scratch:a', buffer.path, buffer, () => {});
    buffer.setContent('private unsaved text');
    disk.lock();
    await expect(buffer.save()).rejects.toMatchObject({ code: 'EACCES' });
    await expect(buffer.reload()).rejects.toMatchObject({ code: 'EACCES' });
    expect(buffer.content).toBe('private unsaved text');
    expect(buffer.isDirty).toBe(true);
    expect(drafts.read('scratch:a', buffer.path)?.content).toBe('private unsaved text');
    expect(new MemoryEditorDrafts().read('scratch:a', buffer.path)).toBeNull();
    off(); buffer.dispose();
  });

  it('restores keystrokes entered during save against the newly saved baseline after lock', async () => {
    const drafts = new MemoryEditorDrafts();
    const disk = storage();
    let finishWrite!: () => void;
    const writing = new Promise<void>((resolve) => { finishWrite = resolve; });
    disk.writeFile.mockImplementationOnce(async (_path, content) => { await writing; disk.externalWrite(content); });
    const buffer = await FileBuffer.open({ zfs: disk.zfs, path: '/note.txt' });
    const off = drafts.attach('ref:a:_1', buffer.path, buffer, () => {});
    buffer.setContent('first edit');
    const saved = buffer.save();
    buffer.setContent('keystrokes during save');
    finishWrite();
    await saved;
    expect(drafts.read('ref:a:_1', buffer.path)).toEqual({ content: 'keystrokes during save', savedContent: 'first edit' });
    disk.lock();
    off(); buffer.dispose();
    disk.unlock();
    const restored = await FileBuffer.open({ zfs: disk.zfs, path: buffer.path });
    const snapshots: EditorDraftSnapshot[] = [];
    const detach = drafts.attach('ref:a:_1', restored.path, restored, (snapshot) => snapshots.push(snapshot));
    expect(restored.content).toBe('keystrokes during save');
    expect(restored.isDirty).toBe(true);
    expect(snapshots.at(-1)?.externallyChanged).toBe(false);
    expect(disk.disk()).toBe('first edit');
    detach(); restored.dispose();
  });

  it('explicit close clears selection while preserving a draft until save, discard, or page reset', async () => {
    const drafts = new MemoryEditorDrafts();
    const disk = storage();
    const buffer = await FileBuffer.open({ zfs: disk.zfs, path: '/note.txt' });
    const off = drafts.attach('scratch:a', buffer.path, buffer, () => {});
    buffer.setContent('pending');
    drafts.close('scratch:a', buffer.path);
    expect(drafts.selectedFile('scratch:a')).toBeNull();
    expect(drafts.read('scratch:a', buffer.path)?.content).toBe('pending');
    buffer.setContent('saved text');
    expect(drafts.read('scratch:a', buffer.path)).toBeNull();
    off(); buffer.dispose();
  });
});
