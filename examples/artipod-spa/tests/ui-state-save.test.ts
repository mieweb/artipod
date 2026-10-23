import { describe, expect, it } from 'vitest';
import { memoryStateMedium, UiStateIO } from '../lib/services/ui-state';

describe('registry save obligations', () => {
  it('keeps failed fields across unrelated fields, actors, entries, and record refreshes', async () => {
    const medium = memoryStateMedium();
    const io = new UiStateIO(medium);
    await io.recordWorkspace('a', 'pod', 'rw');
    await io.recordWorkspace('b', 'blank', 'rw');
    await io.patch('a', { unsynced: false });
    const write = medium.write;
    const failure = new Error('EACCES before the registry write was enqueued');
    medium.write = async () => { throw failure; };
    await expect(io.patch('a', { unsynced: true, encrypted: true })).rejects.toBe(failure);
    medium.write = write;
    await io.patch('a', { hasChanges: true });
    await io.actorId();
    await io.patch('b', { unsynced: true, encrypted: true });
    await io.recordWorkspace('a', 'pod', 'cow');
    await io.patch('a', {});
    await expect(io.flush()).rejects.toBe(failure);
    expect((await io.read()).workspaces.find(entry => entry.id === 'a')).toMatchObject({ unsynced: false, hasChanges: true, mode: 'cow' });
    await io.patch('a', { unsynced: true });
    await expect(io.flush()).rejects.toBe(failure); // encrypted is still unsaved.
    await io.patch('a', { encrypted: true });
    await io.flush();
  });

  it('a record retry covers presence and record fields while deletion supersedes only removed entries', async () => {
    const medium = memoryStateMedium();
    const io = new UiStateIO(medium);
    const write = medium.write;
    const recordFailure = new Error('The new entry was not recorded');
    medium.write = async () => { throw recordFailure; };
    await expect(io.recordWorkspace('a', 'pod', 'cow')).rejects.toBe(recordFailure);
    medium.write = write;
    await io.recordWorkspace('b', 'pod', 'rw');
    await expect(io.flush()).rejects.toBe(recordFailure);
    await io.recordWorkspace('a', 'pod', 'cow');
    await io.flush();

    const patchFailure = new Error('Workspace flags were not saved');
    medium.write = async () => { throw patchFailure; };
    await expect(io.patch('a', { unsynced: true })).rejects.toBe(patchFailure);
    await expect(io.patch('b', { encrypted: true })).rejects.toBe(patchFailure);
    medium.write = write;
    await io.drop(['a']);
    await expect(io.flush()).rejects.toBe(patchFailure);
    await io.drop(['b']);
    await io.flush();
    expect((await io.read()).workspaces).toEqual([]);
  });

  it('a failed batch drop remains pending for IDs outside a successful partial retry', async () => {
    const medium = memoryStateMedium();
    const io = new UiStateIO(medium);
    await io.recordWorkspace('a', 'blank', 'rw');
    await io.recordWorkspace('b', 'blank', 'rw');
    const write = medium.write;
    const failure = new Error('The entries were not removed');
    medium.write = async () => { throw failure; };
    await expect(io.drop(['a', 'b'])).rejects.toBe(failure);
    medium.write = write;
    await io.drop(['a']);
    await expect(io.flush()).rejects.toBe(failure);
    await io.recordWorkspace('b', 'blank', 'rw'); // New presence supersedes the old removal request.
    await io.flush();
  });

  it('recovery acknowledgement drains its accepted mutations and preserves later failures', async () => {
    const medium = memoryStateMedium();
    const io = new UiStateIO(medium);
    await io.recordWorkspace('a', 'pod', 'rw');
    let started!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const oldFailure = new Error('A write on the old generation failed');
    const newFailure = new Error('A write after recovery failed');
    let writes = 0;
    medium.write = async () => {
      writes += 1;
      if (writes === 1) { started(); await gate; throw oldFailure; }
      throw newFailure;
    };
    const oldWrite = io.patch('a', { unsynced: true });
    await writing;
    let acknowledged = false;
    const acknowledgement = io.acknowledgeRecovery().then(() => { acknowledged = true; });
    const newWrite = io.patch('a', { encrypted: true });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    finish();
    await expect(oldWrite).rejects.toBe(oldFailure);
    await acknowledgement;
    await expect(newWrite).rejects.toBe(newFailure);
    await expect(io.flush()).rejects.toBe(newFailure);
    await io.acknowledgeRecovery();
    await io.flush();
  });
});
