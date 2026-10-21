import { describe, expect, it, vi } from 'vitest';
import { createStorageSession, StorageClosePersistenceError } from '@artipod/core/storage';
import { disposeSessionResources, SessionDisposalError, SessionLifecycle } from '../lib/services/pod-session-lifecycle';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('workspace session lifecycle', () => {
  it('reserves teardown before a new route boots despite core teardown microtask deferral', async () => {
    const drain = deferred();
    const closing = deferred();
    const events: string[] = [];
    let provider: string | null = null;
    const lifecycle = new SessionLifecycle(async (id: string) => {
      provider = id;
      events.push(`boot ${id}`);
      return { close: vi.fn(async () => {
        events.push(`close ${id}`);
        if (id === 'old') { closing.resolve(); await drain.promise; }
        expect(provider).toBe(id);
        provider = null;
        events.push(`dispose ${id}`);
      }) };
    });
    const old = lifecycle.open('old');
    await old;
    const storage = createStorageSession({ policy: 'memory' });
    const teardown = storage.registerTeardown(() => old.close(), 'Workspace session');
    // React cleanup and the next effect both run before core invokes close.
    const cleanup = teardown();
    const fresh = lifecycle.open('fresh');
    await closing.promise;
    expect(events).toEqual(['boot old', 'close old']);
    drain.resolve();
    await cleanup;
    await fresh;
    expect(events).toEqual(['boot old', 'close old', 'dispose old', 'boot fresh']);
    expect(provider).toBe('fresh');
    await fresh.close();
  });

  it('waits for a canceled in-flight boot and its disposal before starting its replacement', async () => {
    const bootStarted = deferred();
    const bootReady = deferred();
    const closeStarted = deferred();
    const disposed = deferred();
    const events: string[] = [];
    const lifecycle = new SessionLifecycle(async (id: string) => {
      events.push(`boot ${id}`);
      if (id === 'old') { bootStarted.resolve(); await bootReady.promise; }
      return { close: async () => {
        events.push(`close ${id}`);
        if (id === 'old') { closeStarted.resolve(); await disposed.promise; }
      } };
    });
    const old = lifecycle.open('old');
    await bootStarted.promise;
    const cleanup = old.close();
    const fresh = lifecycle.open('fresh');
    bootReady.resolve();
    await closeStarted.promise;
    expect(events).toEqual(['boot old', 'close old']);
    disposed.resolve();
    await cleanup;
    await fresh;
    expect(events).toEqual(['boot old', 'close old', 'boot fresh']);
    await fresh.close();
  });

  it('cancels superseded queued openings without creating their mounts or providers', async () => {
    const boot = vi.fn(async (id: string) => ({ id, close: vi.fn(async () => {}) }));
    const lifecycle = new SessionLifecycle(boot);
    const first = lifecycle.open('first');
    const second = lifecycle.open('second');
    const third = lifecycle.open('third');
    await expect(first).rejects.toThrow('opening was cancelled');
    await expect(second).rejects.toThrow('opening was cancelled');
    expect((await third).id).toBe('third');
    expect(boot.mock.calls).toEqual([['third']]);
    await third.close();
  });

  it('keeps cleanup idempotent and opens the next route after a failed final flush', async () => {
    const failure = new StorageClosePersistenceError(new Error('final persistence failed'));
    const dispose = vi.fn(async () => { throw failure; });
    const lifecycle = new SessionLifecycle(async (id: string) => ({ id, close: id === 'old' ? dispose : vi.fn(async () => {}) }), error => error instanceof StorageClosePersistenceError);
    const old = lifecycle.open('old');
    const oldSession = await old;
    const cleanup = old.close();
    expect(old.close()).toBe(cleanup);
    expect(oldSession.close()).toBe(cleanup);
    const fresh = lifecycle.open('fresh');
    await expect(cleanup).rejects.toBe(failure);
    expect((await fresh).id).toBe('fresh');
    expect(dispose).toHaveBeenCalledOnce();
    await fresh.close();
  });

  it('retains a blocking error after unexpected disposal failure across repeated replacements', async () => {
    const failure = new Error('provider disposal failed');
    const boot = vi.fn(async (id: string) => ({ id, close: async () => { throw failure; } }));
    const lifecycle = new SessionLifecycle(boot, error => error instanceof StorageClosePersistenceError);
    const old = lifecycle.open('old');
    await old;
    await expect(old.close()).rejects.toBe(failure);
    const fresh = lifecycle.open('fresh');
    await expect(fresh).rejects.toBeInstanceOf(SessionDisposalError);
    await expect(fresh.close()).rejects.toBeInstanceOf(SessionDisposalError);
    await expect(lifecycle.open('another')).rejects.toBeInstanceOf(SessionDisposalError);
    expect(boot).toHaveBeenCalledOnce();
  });

  it('attempts every resource release and classifies cleanup failure as unsafe to reuse', () => {
    const runtime = vi.fn(() => { throw new Error('runtime failed'); });
    const unsubscribe = vi.fn(() => { throw new Error('unsubscribe failed'); });
    const sandbox = vi.fn();
    const pod = vi.fn();
    const writerLock = vi.fn();
    expect(() => disposeSessionResources([runtime, unsubscribe, sandbox, pod, writerLock])).toThrow(SessionDisposalError);
    for (const release of [runtime, unsubscribe, sandbox, pod, writerLock]) expect(release).toHaveBeenCalledOnce();
  });

  it('does not deadlock replacement after the prior boot rejects', async () => {
    const failure = new Error('boot failed');
    const lifecycle = new SessionLifecycle(async (id: string) => {
      if (id === 'old') throw failure;
      return { id, close: vi.fn(async () => {}) };
    });
    const old = lifecycle.open('old');
    await expect(old).rejects.toBe(failure);
    const cleanup = old.close();
    const fresh = lifecycle.open('fresh');
    await cleanup;
    expect((await fresh).id).toBe('fresh');
    await fresh.close();
  });
});
