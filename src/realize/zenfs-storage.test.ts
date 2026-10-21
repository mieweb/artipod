import { afterEach, describe, expect, it } from 'vitest';
import { defineCommand } from 'just-bash/browser';
import { createStorageSession, type StorageSession } from '../storage/session.js';
import type { Sandbox, SandboxExecResult } from '../sandbox/types.js';
import { createZenFsPod, type ZenFsPod, type ZenFsPodOptions } from './zenfs.js';

const sessions: StorageSession[] = [];
const pods: ZenFsPod[] = [];
const shells: Sandbox[] = [];
const finishCommands: Array<() => void> = [];
afterEach(async () => {
  finishCommands.splice(0).forEach(finish => finish());
  shells.splice(0).forEach(shell => shell.dispose());
  pods.splice(0).forEach(pod => pod.dispose());
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
});

async function workspace(value: string, options: Pick<ZenFsPodOptions, 'extraCommands'> = {}) {
  const session = createStorageSession({ policy: 'memory' });
  sessions.push(session);
  const storage = await session.open();
  await storage.zfs.promises.mkdir('/private', { recursive: true });
  await storage.zfs.promises.writeFile('/private/marker.txt', value);
  const pod = await createZenFsPod({ mounts: [{ name: 'private', path: '/private', mode: 'rw', source: { kind: 'backend', backend: 'memory' } }] }, { storage, storagePolicy: 'protected', proc: false, ...options });
  pods.push(pod);
  const shell = pod.createSandbox({ confineTo: '/private' });
  shells.push(shell);
  return { session, shell };
}

async function result(shell: Sandbox, command: string): Promise<SandboxExecResult> {
  try { return await shell.exec(command); }
  catch (error) { return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: 1 }; }
}

describe('confined shell storage ownership', () => {
  it('rejects a stale confined shell after a memory root is replaced while a fresh shell reads normally', async () => {
    const old = await workspace('original workspace');
    expect((await old.shell.exec('cat /marker.txt')).stdout).toBe('original workspace');
    const handle = await old.shell.zfs.promises.open('/marker.txt', 'r');
    await old.session.close();
    const fresh = await workspace('PRIVATE-replacement-workspace');
    expect((await fresh.shell.exec('cat /marker.txt')).stdout).toBe('PRIVATE-replacement-workspace');
    const stale = await result(old.shell, 'cat /marker.txt');
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stdout).not.toContain('PRIVATE-replacement-workspace');
    await expect(old.shell.zfs.promises.readFile('/marker.txt', 'utf8')).rejects.toThrow(/closed|core storage context|changed|no longer/i);
    await expect(handle.readFile('utf8')).rejects.toThrow(/closed|core storage context|changed|no longer/i);
  });

  it('denies filesystem access after a command awaited across close and root replacement', async () => {
    let begin!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>(resolve => { begin = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    finishCommands.push(finish);
    const old = await workspace('original workspace', { extraCommands: [defineCommand('wait-for-replacement', async () => {
      begin();
      await blocked;
      return { stdout: '', stderr: '', exitCode: 0 };
    })] });
    const reading = result(old.shell, 'wait-for-replacement; cat /marker.txt');
    await entered;
    await old.session.close();
    const fresh = await workspace('PRIVATE-after-command-await');
    expect((await fresh.shell.exec('cat /marker.txt')).stdout).toBe('PRIVATE-after-command-await');
    finish();
    const stale = await reading;
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stdout).not.toContain('PRIVATE-after-command-await');
    const write = await result(old.shell, 'echo overwritten > /marker.txt');
    expect(write.exitCode).not.toBe(0);
    expect((await fresh.shell.exec('cat /marker.txt')).stdout).toBe('PRIVATE-after-command-await');
  });
});
