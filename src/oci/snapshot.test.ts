/**
 * Snapshots + commit tests — the Phase 5 done-when list, verbatim:
 * branch-and-checkout with simultaneous mounts, exact diff paths, agent
 * auto-snapshots (default on, opt-out), compact + gc with byte counts,
 * plus commit → image mount round-trip.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import { createZenFsPod, type ZenFsPod } from '../realize/zenfs.js';
import { ToolCallingLoop } from '../agent/loop.js';
import { OzwellClient } from '../agent/ozwell-client.js';
import type { ChatCompletionResponse, ChatMessage } from '../agent/types.js';
import type { Sandbox } from '../sandbox/types.js';

let pod: ZenFsPod;
let sandbox: Sandbox;

function unmountAll() {
  for (const path of [...zenMounts.keys()]) {
    if (path !== '/') {
      try {
        umount(path);
      } catch {
        /* fine */
      }
    }
  }
  try {
    umount('/');
  } catch {
    /* fine */
  }
}

beforeEach(async () => {
  unmountAll();
  await configure({ mounts: { '/': InMemory } });
  await zfs.promises.mkdir('/repo');
  pod = await createZenFsPod(
    { mounts: [{ name: 'root', path: '/', source: { kind: 'backend', backend: 'memory' }, mode: 'rw' }] },
    { adopt: zfs, cwd: '/repo', proc: false },
  );
  sandbox = pod.createSandbox();
});

describe('snapshot create / checkout / mount (done-when 1)', () => {
  it('edit → snapshot → edit → checkout: both branches mountable simultaneously', async () => {
    await sandbox.exec('echo v1 > /repo/story.md && mkdir /repo/sub && echo deep > /repo/sub/d.txt');
    const snap = (await pod.snapshots.create({ label: 'first draft' }))!;
    expect(snap.diff.entryCount).toBeGreaterThan(0);

    // keep editing on the main line
    await sandbox.exec('echo v2 > /repo/story.md && rm /repo/sub/d.txt && echo new > /repo/added.txt');

    // zero-copy read-only mount of the snapshot…
    const { at } = await pod.snapshots.mount(snap.id);
    expect((await sandbox.exec(`cat ${at}/repo/story.md`)).stdout).toBe('v1\n');
    expect((await sandbox.exec(`cat ${at}/repo/sub/d.txt`)).stdout).toBe('deep\n');

    // …and a writable branch, simultaneously, while the live tree stays v2
    const branch = await pod.snapshots.checkout(snap.id);
    expect((await sandbox.exec(`cat ${branch}/repo/story.md`)).stdout).toBe('v1\n');
    await sandbox.exec(`echo branched >> ${branch}/repo/story.md`);
    expect((await sandbox.exec(`cat ${branch}/repo/story.md`)).stdout).toBe('v1\nbranched\n');
    expect((await sandbox.exec('cat /repo/story.md')).stdout).toBe('v2\n'); // live tree untouched
    expect((await sandbox.exec(`cat ${at}/repo/story.md`)).stdout).toBe('v1\n'); // ro mount untouched
  });
});

describe('snapshot diff (done-when 2)', () => {
  it('lists exactly the expected added/modified/deleted paths', async () => {
    await sandbox.exec('echo one > /repo/a.txt && echo keep > /repo/keep.txt');
    const s1 = (await pod.snapshots.create())!;
    await sandbox.exec('echo two > /repo/a.txt && rm /repo/keep.txt && echo fresh > /repo/b.txt');
    const s2 = (await pod.snapshots.create())!;

    const diff = await pod.snapshots.diff(s1.id, s2.id);
    expect(diff.added).toEqual(['/repo/b.txt']);
    expect(diff.modified).toEqual(['/repo/a.txt']);
    expect(diff.deleted).toEqual(['/repo/keep.txt']);

    // diff against the live worktree
    await sandbox.exec('echo three > /repo/c.txt');
    const live = await pod.snapshots.diff(s2.id);
    expect(live.added).toEqual(['/repo/c.txt']);
    expect(live.modified).toEqual([]);
    expect(live.deleted).toEqual([]);
  });

  it('shell surface: artipod snapshot create/ls/diff', async () => {
    await sandbox.exec('echo x > /repo/x.txt');
    const created = await sandbox.exec('artipod snapshot create my label');
    expect(created.exitCode).toBe(0);
    await sandbox.exec('echo y > /repo/y.txt');
    const lsOut = await sandbox.exec('artipod snapshot ls');
    expect(lsOut.stdout).toContain('my label');
    const id = /snapshot (snap-[0-9a-f]+) created/.exec(created.stdout)![1];
    const diffOut = await sandbox.exec(`artipod snapshot diff ${id}`);
    expect(diffOut.stdout.trim()).toBe('A /repo/y.txt');
  });
});

describe('agent auto-snapshot (done-when 3)', () => {
  function scriptedClient(script: Array<Partial<ChatMessage>>): OzwellClient {
    let call = 0;
    const fetchFn: typeof fetch = async () => {
      const message = script[Math.min(call++, script.length - 1)];
      const response: ChatCompletionResponse = {
        id: `fake-${call}`,
        object: 'chat.completion',
        created: Date.now() / 1000,
        model: 'fake',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null, ...message } as ChatMessage,
            finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
          },
        ],
      };
      return new Response(JSON.stringify(response), { status: 200 });
    };
    return new OzwellClient({ baseUrl: 'http://fake', apiKey: 'k', fetchFn });
  }

  const bashCall = (id: string, command: string) => ({
    id,
    type: 'function' as const,
    function: { name: 'bash', arguments: JSON.stringify({ command }) },
  });

  it('default on: a snapshot lands before each tool-executing turn', async () => {
    await sandbox.exec('echo seed > /repo/seed.txt');
    const client = scriptedClient([
      { tool_calls: [bashCall('c1', 'echo turn1 > /repo/t1.txt')] },
      { tool_calls: [bashCall('c2', 'echo turn2 > /repo/t2.txt')] },
      { content: 'done' },
    ]);
    const loop = new ToolCallingLoop(client, pod.createAgentTools(sandbox));
    await loop.run('do things', { ...pod.agentLoopOptions() });

    const list = await pod.snapshots.list();
    const agentSnaps = list.filter((s) => s.origin === 'agent-turn');
    expect(agentSnaps.length).toBe(2); // one per tool-executing turn
    // rewind = the pre-turn-2 snapshot has t1 but not t2
    const preTurn2 = agentSnaps[1];
    const { at } = await pod.snapshots.mount(preTurn2.id);
    expect((await sandbox.exec(`cat ${at}/repo/t1.txt`)).stdout).toBe('turn1\n');
    expect((await sandbox.exec(`ls ${at}/repo`)).stdout).not.toContain('t2.txt');
  });

  it('opt-out flag suppresses auto-snapshots', async () => {
    const client = scriptedClient([
      { tool_calls: [bashCall('c1', 'echo x > /repo/x.txt')] },
      { content: 'ok' },
    ]);
    const loop = new ToolCallingLoop(client, pod.createAgentTools(sandbox));
    await loop.run('do it', { ...pod.agentLoopOptions({ autoSnapshot: false }) });
    expect((await pod.snapshots.list()).filter((s) => s.origin === 'agent-turn')).toHaveLength(0);
  });
});

describe('commit / compact / gc (done-when 4 + commit round-trip)', () => {
  it('commit --tag freezes the workspace into a mountable volume image', async () => {
    await sandbox.exec('echo publishme > /repo/final.txt');
    const commit = await sandbox.exec('artipod commit --tag work/final:1');
    expect(commit.exitCode).toBe(0);
    const mountR = await sandbox.exec('artipod image mount work/final:1 /mnt/final');
    expect(mountR.exitCode).toBe(0);
    expect((await sandbox.exec('cat /mnt/final/repo/final.txt')).stdout).toBe('publishme\n');
  });

  it('compact squashes the chain into one layer; gc reclaims superseded bytes', async () => {
    // build a 3-snapshot chain with churn
    await sandbox.exec('echo a > /repo/a.txt');
    await pod.snapshots.create();
    await sandbox.exec('echo b > /repo/b.txt && echo a2 > /repo/a.txt');
    await pod.snapshots.create();
    await sandbox.exec('rm /repo/b.txt && echo c > /repo/c.txt');
    const last = (await pod.snapshots.create())!;

    const before = await pod.snapshots.list();
    expect(before.length).toBe(3);

    const compacted = await pod.snapshots.compact();
    expect(compacted.parent).toBeNull();
    expect(compacted.origin).toBe('compact');
    const after = await pod.snapshots.list();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(compacted.id);

    // the compacted view equals the last chain state
    const { at } = await pod.snapshots.mount(compacted.id);
    expect((await sandbox.exec(`cat ${at}/repo/a.txt`)).stdout).toBe('a2\n');
    expect((await sandbox.exec(`cat ${at}/repo/c.txt`)).stdout).toBe('c\n');
    expect((await sandbox.exec(`ls ${at}/repo`)).stdout).not.toContain('b.txt');
    expect(last.diff.diffId).not.toBe(compacted.diff.diffId);

    // gc sweeps the superseded chain blobs and reports bytes
    const result = await pod.snapshots.gc();
    expect(result.deleted).toBeGreaterThan(0);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    // compacted snapshot still mounts after gc
    const { at: at2 } = await pod.snapshots.mount(compacted.id, '/mnt/after-gc');
    expect((await sandbox.exec(`cat ${at2}/repo/c.txt`)).stdout).toBe('c\n');
  });

  it('gc keeps everything reachable from refs (committed volumes)', async () => {
    await sandbox.exec('echo keepme > /repo/k.txt');
    await sandbox.exec('artipod commit --tag keep/me:1');
    const swept = await pod.snapshots.gc();
    void swept;
    const mountR = await sandbox.exec('artipod image mount keep/me:1 /mnt/kept');
    expect(mountR.exitCode).toBe(0);
    expect((await sandbox.exec('cat /mnt/kept/repo/k.txt')).stdout).toBe('keepme\n');
  });
});
