/**
 * The process table and its shell surface: `ps`, `kill`, `/proc/<pid>`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { createSandbox, type Sandbox } from '../sandbox/index.js';
import { clearProcProviders } from './registry.js';
import { unmountProc } from './snapshot.js';
import { ProcessError, ProcessTable, registerProcessTable } from './processes.js';

describe('ProcessTable', () => {
  it('starts with pid 1, allocates pids upward, and cascades on dispose', async () => {
    let clock = 1000;
    const table = new ProcessTable('session', () => clock);
    const killed: string[] = [];
    expect(table.list().map((p) => [p.pid, p.kind, p.name])).toEqual([[1, 'init', 'session']]);
    const shell = table.spawn({ kind: 'shell', name: 'bash', state: 'idle' });
    clock = 5000;
    const app = table.spawn({ kind: 'app', name: 'Lifecycle sample', detail: { mode: 'development' }, signal: { KILL: () => { killed.push('app'); } } });
    expect(shell.pid).toBe(2);
    expect(app.pid).toBe(3);
    expect(table.get(3)).toMatchObject({ ppid: 1, startedAt: 5000, signals: ['KILL'], detail: { mode: 'development' } });
    const changes = vi.fn();
    table.subscribe(changes);
    app.update({ state: 'suspended', detail: { elapsed: '4s' } });
    expect(table.get(3)).toMatchObject({ state: 'suspended', detail: { mode: 'development', elapsed: '4s' } });
    expect(changes).toHaveBeenCalledTimes(1);
    shell.exit();
    shell.exit();
    expect(table.list().map((p) => p.pid)).toEqual([1, 3]);
    await table.dispose();
    expect(killed).toEqual(['app']);
    expect(table.list().map((p) => p.pid)).toEqual([1]);
    expect(() => table.spawn({ kind: 'shell', name: 'late' })).toThrow(ProcessError);
    app.update({ state: 'zombie' });
    expect(table.get(3)).toBeUndefined();
  });

  it('delivers signals per kind and fails closed otherwise', async () => {
    const table = new ProcessTable();
    const calls: string[] = [];
    table.spawn({ kind: 'app', name: 'a', signal: { STOP: () => { calls.push('STOP'); }, TERM: async () => { calls.push('TERM'); } } });
    await table.signal(2, 'STOP');
    await table.signal(2, 'TERM');
    expect(calls).toEqual(['STOP', 'TERM']);
    await expect(table.signal(2, 'CONT')).rejects.toMatchObject({ code: 'ENOTSUP' });
    await expect(table.signal(9, 'TERM')).rejects.toMatchObject({ code: 'ESRCH' });
    await expect(table.signal(1, 'KILL')).rejects.toMatchObject({ code: 'EPERM' });
    expect(() => table.spawn({ kind: 'task', name: 'orphan', ppid: 42 })).toThrow(/no such parent/);
  });

  it('projects /proc/<pid>/status and cmdline', async () => {
    const table = new ProcessTable('session', () => 0);
    table.spawn({ kind: 'task', name: 'sync:push', state: 'idle', signal: { TERM: () => {} } });
    const tree = await table.provider().read();
    expect(Object.keys(tree).sort()).toEqual(['1/cmdline', '1/status', '2/cmdline', '2/status']);
    expect(tree['2/cmdline']).toBe('task:sync:push\n');
    expect(tree['2/status']).toContain('State:\tidle');
    expect(tree['2/status']).toContain('Signals:\tTERM');
    expect(tree['2/status']).toContain('Started:\t1970-01-01T00:00:00.000Z');
  });
});

describe('ps / kill in the shell', () => {
  let sandbox: Sandbox;
  let table: ProcessTable;
  const signals: string[] = [];

  beforeEach(async () => {
    await unmountProc();
    clearProcProviders();
    signals.length = 0;
    try { umount('/'); } catch { /* first run */ }
    await configure({ mounts: { '/': InMemory } });
    await zfs.promises.mkdir('/repo');
    table = new ProcessTable('session', () => 0);
    registerProcessTable(table);
    sandbox = createSandbox({ zfs, proc: true, cwd: '/repo', processes: table });
    table.spawn({ kind: 'app', name: 'Lifecycle sample', detail: { mode: 'development' }, signal: {
      STOP: () => { signals.push('STOP'); }, CONT: () => { signals.push('CONT'); }, TERM: () => { signals.push('TERM'); },
    } });
    table.spawn({ kind: 'task', name: 'sync:push', state: 'idle' });
  });

  it('registers the shell as a process whose state follows exec, and lists everything', async () => {
    expect(table.get(2)).toMatchObject({ kind: 'shell', name: 'bash', state: 'idle', detail: { cwd: '/repo' } });
    const r = await sandbox.exec('ps');
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^PID\s+PPID\s+KIND\s+STATE\s+TIME\s+NAME$/);
    expect(lines[1]).toMatch(/^\s*1\s+0\s+init\s+running\s+\S+\s+session$/);
    expect(lines[2]).toMatch(/^\s*2\s+1\s+shell\s+running\s+\S+\s+bash$/);
    expect(lines[3]).toMatch(/^\s*3\s+1\s+app\s+running\s+\S+\s+Lifecycle sample$/);
    expect(lines[4]).toMatch(/^\s*4\s+1\s+task\s+idle\s+\S+\s+\[sync:push\]$/);
    expect(table.get(2)?.state).toBe('idle');
    const long = await sandbox.exec('ps -l');
    expect(long.stdout).toContain('mode=development');
    await sandbox.exec('cd /');
    expect(table.get(2)?.detail.cwd).toBe('/');
    const scratch = createSandbox({ zfs, cwd: '/repo', processes: table });
    expect(table.list().filter((p) => p.kind === 'shell')).toHaveLength(2);
    scratch.dispose();
    scratch.dispose();
    expect(table.list().filter((p) => p.kind === 'shell')).toHaveLength(1);
  });

  it('kill sends the named signal, defaults to TERM, and reports failures per pid', async () => {
    expect((await sandbox.exec('kill -STOP 3')).exitCode).toBe(0);
    expect((await sandbox.exec('kill -SIGCONT 3')).exitCode).toBe(0);
    expect((await sandbox.exec('kill 3')).exitCode).toBe(0);
    expect(signals).toEqual(['STOP', 'CONT', 'TERM']);
    const r = await sandbox.exec('kill -KILL 3 4 9 1');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('kill: (3) - Operation not supported');
    expect(r.stderr).toContain('kill: (4) - Operation not supported');
    expect(r.stderr).toContain('kill: (9) - No such process');
    expect(r.stderr).toContain('kill: (1) - Operation not permitted');
    expect((await sandbox.exec('kill -HUP 3')).stderr).toContain('invalid signal');
    expect((await sandbox.exec('kill abc')).exitCode).toBe(2);
  });

  it('exposes /proc/<pid>/status to the shell', async () => {
    const r = await sandbox.exec('cat /proc/3/status; cat /proc/3/cmdline');
    expect(r.stdout).toContain('Name:\tLifecycle sample');
    expect(r.stdout).toContain('Mode:\tdevelopment');
    expect(r.stdout).toContain('app:Lifecycle sample');
  });
});
