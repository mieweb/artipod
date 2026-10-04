import { describe, expect, it } from 'vitest';
import { TaskScheduler } from '../lib/services/task-scheduler';
import { UiStateIO, memoryStateMedium, upperDirName } from '../lib/services/ui-state';
import { registryActions, registryStore } from '../lib/stores/registry';
import { computeVerdicts, healUnsynced } from '../lib/services/catalog-service';
import { initialSyncState, reduceSync, wantsPush, type SyncEvent, type SyncState } from '../lib/services/sync-machine';

describe('TaskScheduler (the artipod ps substrate)', () => {
  it('runs, records results, and re-arms recurring tasks', async () => {
    const sched = new TaskScheduler();
    let runs = 0;
    sched.register('tick', () => {
      runs += 1;
      if (runs === 1) throw new Error('first fails');
    });
    await sched.run('tick');
    expect(sched.list()[0]).toMatchObject({ name: 'tick', state: 'idle', lastResult: 'error', lastError: 'first fails' });
    await sched.run('tick');
    expect(sched.list()[0].lastResult).toBe('ok');
    expect(sched.list()[0].lastRunAt).toBeGreaterThan(0);
    sched.dispose();
  });

  it('schedule() sets nextRunAt and cancel() clears it', () => {
    const sched = new TaskScheduler(() => 1000);
    sched.register('later', () => {});
    sched.schedule('later', 5000);
    expect(sched.list()[0]).toMatchObject({ state: 'scheduled', nextRunAt: 6000 });
    sched.cancel('later');
    expect(sched.list()[0]).toMatchObject({ state: 'idle', nextRunAt: undefined });
    sched.dispose();
  });
});

describe('UiStateIO + registryStore (write-through over the fs file)', () => {
  it('mints a stable actor id once', async () => {
    const io = new UiStateIO(memoryStateMedium());
    const a = await io.actorId();
    expect(a).toMatch(/^browser:/);
    expect(await io.actorId()).toBe(a);
  });

  it('record/patch/drop round-trip through the medium and refresh the snapshot', async () => {
    const io = new UiStateIO(memoryStateMedium());
    const actions = registryActions(io);
    await actions.record('doug:_1', 'pod', 'cow');
    await actions.record('blank-1', 'blank', 'rw');
    expect(registryStore.getState().entries.map((e) => e.id)).toEqual(['blank-1', 'doug:_1']);

    await actions.patch('doug:_1', { hasChanges: true, encrypted: true });
    const doug = registryStore.getState().entries.find((e) => e.id === 'doug:_1');
    expect(doug).toMatchObject({ hasChanges: true, encrypted: true, mode: 'cow' });

    await actions.drop(['blank-1']);
    expect(registryStore.getState().entries.map((e) => e.id)).toEqual(['doug:_1']);
  });

  it('re-recording preserves flags and bumps recency (old-app parity)', async () => {
    const io = new UiStateIO(memoryStateMedium());
    const actions = registryActions(io);
    await actions.record('a:_1', 'pod', 'cow');
    await actions.patch('a:_1', { unsynced: true });
    await actions.record('a:_1', 'pod', 'cow');
    expect(registryStore.getState().entries[0]).toMatchObject({ id: 'a:_1', unsynced: true });
  });

  it('concurrent mutations serialize under the medium lock', async () => {
    const io = new UiStateIO(memoryStateMedium());
    await Promise.all(Array.from({ length: 10 }, (_, i) => io.recordWorkspace(`ref-${i}`, 'pod', 'cow')));
    expect((await io.read()).workspaces).toHaveLength(10);
  });

  it('upperDirName is a stable opaque hash (hides which refs have forks)', async () => {
    const name = await upperDirName('doug:_1');
    expect(name).toMatch(/^[0-9a-f]{16}$/);
    expect(await upperDirName('doug:_1')).toBe(name);
    expect(await upperDirName('lin:_1')).not.toBe(name);
    expect(name).not.toContain('doug');
  });
});

describe('computeVerdicts (ancestry beats recorded flags)', () => {
  // DAG: base ← serverHead ← localAhead ; divergent is unrelated
  const walker = async (ancestor: string, descendant: string): Promise<boolean> => {
    const parents: Record<string, string[]> = {
      localAhead: ['serverHead'],
      serverHead: ['base'],
      divergent: ['base'],
    };
    const seen = new Set<string>();
    const walk = (d: string): boolean => {
      if (d === ancestor) return true;
      if (seen.has(d)) return false;
      seen.add(d);
      return (parents[d] ?? []).some(walk);
    };
    return walk(descendant);
  };

  it('classifies synced / ahead / behind and skips refs without local heads', async () => {
    const verdicts = await computeVerdicts({
      serverRefs: [
        { ref: 'same', manifestDigest: 'serverHead' },
        { ref: 'fork', manifestDigest: 'serverHead' },
        { ref: 'stale', manifestDigest: 'serverHead' },
        { ref: 'nolocal', manifestDigest: 'serverHead' },
      ],
      localHeads: new Map([
        ['same', 'serverHead'],
        ['fork', 'localAhead'],
        ['stale', 'divergent'],
      ]),
      isAncestor: walker,
    });
    expect(verdicts.get('same')).toBe('synced');
    expect(verdicts.get('fork')).toBe('ahead');
    expect(verdicts.get('stale')).toBe('behind');
    expect(verdicts.has('nolocal')).toBe(false);
  });

  it('walker failures leave no verdict (the recorded flag stands)', async () => {
    const verdicts = await computeVerdicts({
      serverRefs: [{ ref: 'x', manifestDigest: 'serverHead' }],
      localHeads: new Map([['x', 'localAhead']]),
      isAncestor: () => Promise.reject(new Error('locked')),
    });
    expect(verdicts.size).toBe(0);
  });

  it('healUnsynced names exactly the flags the verdicts disprove', () => {
    const heal = healUnsynced(
      [
        { id: 'a', unsynced: true },
        { id: 'b', unsynced: true },
        { id: 'c' },
      ],
      new Map([
        ['a', 'synced'],
        ['b', 'ahead'],
        ['c', 'synced'],
      ]),
    );
    expect(heal).toEqual(['a']);
  });
});

describe('push-retry state machine', () => {
  const seq = (events: SyncEvent[]): SyncState => events.reduce(reduceSync, initialSyncState);

  it('edit → push → ok lands on synced', () => {
    const s = seq([{ type: 'edit' }, { type: 'push-start' }, { type: 'push-ok', at: 42 }]);
    expect(s).toMatchObject({ phase: 'synced', lastPushedAt: 42 });
  });

  it('a failed push wants retries on tick and reconnect, and only then', () => {
    const failed = seq([{ type: 'edit' }, { type: 'push-start' }, { type: 'push-fail' }]);
    expect(failed.phase).toBe('failed');
    expect(wantsPush(failed, { type: 'retry-tick' })).toBe(true);
    expect(wantsPush(failed, { type: 'push-fail' })).toBe(false);
    const offline = reduceSync(failed, { type: 'offline' });
    expect(wantsPush(offline, { type: 'retry-tick' })).toBe(false); // never while offline
    const online = reduceSync(offline, { type: 'online' });
    expect(wantsPush(online, { type: 'online' })).toBe(true); // reconnect retries immediately
  });

  it('writes racing an in-flight push trigger a follow-up push', () => {
    let s = seq([{ type: 'edit' }, { type: 'push-start' }]);
    s = reduceSync(s, { type: 'edit' }); // raced
    expect(s.dirtyDuringPush).toBe(true);
    expect(wantsPush(s, { type: 'push-ok', at: 1 })).toBe(true);
    s = reduceSync(s, { type: 'push-ok', at: 1 });
    expect(s.phase).toBe('dirty'); // not synced — there is unpushed work
  });
});
