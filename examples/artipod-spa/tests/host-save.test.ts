import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostSaveCoordinator } from '../lib/services/host-save';
import { memoryStateMedium, UiStateIO } from '../lib/services/ui-state';

afterEach(() => vi.useRealTimers());

describe('host save completion', () => {
  it('runs a debounced registry probe immediately and awaits its entire write chain', async () => {
    vi.useFakeTimers();
    const host = new HostSaveCoordinator();
    const io = new UiStateIO(memoryStateMedium());
    const errors = vi.fn();
    host.schedule(async () => {
      await io.recordWorkspace('private:_1', 'pod', 'cow');
      await Promise.resolve();
      await io.patch('private:_1', { encrypted: true, hasChanges: true });
    }, 500, errors);
    const flush = vi.fn(async () => { await io.flush(); });
    await host.save(flush);
    expect((await io.read()).workspaces).toMatchObject([{ id: 'private:_1', encrypted: true, hasChanges: true }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(errors).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalled();
  });

  it('repeats the storage flush when the flush admits another host write', async () => {
    vi.useFakeTimers();
    const host = new HostSaveCoordinator();
    const values: string[] = [];
    let durable: string[] = [];
    let calls = 0;
    await host.save(async () => {
      calls += 1;
      durable = [...values];
      if (calls === 1) host.schedule(async () => { values.push('late registry metadata'); }, 500, () => {});
    });
    expect(durable).toEqual(['late registry metadata']);
    expect(calls).toBeGreaterThan(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a background failure until that producer is retried or disposed', async () => {
    vi.useFakeTimers();
    const host = new HostSaveCoordinator();
    const failure = new Error('Registry write failed');
    const onError = vi.fn();
    let fail = true;
    const probe = async () => { if (fail) throw failure; };
    host.schedule(probe, 500, onError);
    await expect(host.save(async () => {})).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith(failure);
    fail = false;
    await host.run(probe);
    await host.save(async () => {});
    fail = true;
    await expect(host.run(probe)).rejects.toBe(failure);
    host.forget(probe);
    await host.save(async () => {});
  });

  it('waits for a disposed producer without retaining its late failure for the next workspace', async () => {
    const host = new HostSaveCoordinator();
    let reject!: (error: Error) => void;
    const probe = () => new Promise<void>((_, fail) => { reject = fail; });
    const pending = host.run(probe);
    await Promise.resolve();
    host.forget(probe);
    const saved = host.save(async () => {});
    reject(new Error('The previous filesystem is closed'));
    await expect(pending).rejects.toThrow('closed');
    await saved;
  });

  it('keeps the latest producer outcome when overlapping attempts finish out of order', async () => {
    const host = new HostSaveCoordinator();
    const attempts: Array<{ resolve(): void; reject(error: Error): void }> = [];
    const producer = () => new Promise<void>((resolve, reject) => { attempts.push({ resolve, reject }); });
    const older = host.run(producer);
    const latest = host.run(producer);
    await Promise.resolve();
    const failure = new Error('The latest registry save failed');
    attempts[1].reject(failure);
    await expect(latest).rejects.toBe(failure);
    attempts[0].resolve();
    await older;
    await expect(host.save(async () => {})).rejects.toBe(failure);

    const stale = host.run(producer);
    const retried = host.run(producer);
    await Promise.resolve();
    attempts[3].resolve();
    await retried;
    attempts[2].reject(new Error('An older attempt failed after the successful retry'));
    await expect(stale).rejects.toThrow('older attempt');
    await host.save(async () => {});
  });

  it('awaits registry mutations queued behind a write and retains a failed write for save reporting', async () => {
    const medium = memoryStateMedium();
    const write = medium.write;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let first = true;
    medium.write = async text => { if (first) { first = false; await gate; } await write(text); };
    const io = new UiStateIO(medium);
    const record = io.recordWorkspace('private:_1', 'pod', 'cow');
    const patch = io.patch('private:_1', { encrypted: true });
    let saved = false;
    const saving = io.flush().then(() => { saved = true; });
    await Promise.resolve();
    expect(saved).toBe(false);
    finish();
    await Promise.all([record, patch, saving]);
    expect((await io.read()).workspaces[0]).toMatchObject({ encrypted: true });
    const failure = new Error('Quota exceeded');
    medium.write = async () => { throw failure; };
    await expect(io.patch('private:_1', { hasChanges: true })).rejects.toBe(failure);
    await expect(io.flush()).rejects.toBe(failure);
    medium.write = write;
    await io.patch('private:_1', { hasChanges: true });
    await io.flush();
  });
});
