/**
 * Agent-confinement stub tests (plan Phase 2, Decision #10): sudo is
 * recognized, always denied with EPERM until Phase 6.5, never prompts, and
 * surfaces the attempt as approval:request. docs/security-model.md is
 * normative.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { PodEvents } from '../events.js';
import { createSandbox, SUDO_DENIED_MESSAGE, type Sandbox } from './index.js';

let sandbox: Sandbox;
let events: PodEvents;

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

describe('sudo confinement stub', () => {
  it('denies sudo with EPERM and the Phase 6.5 pointer', async () => {
    const r = await sandbox.exec('sudo rm -rf /');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('EPERM');
    expect(r.stderr).toContain('Phase 6.5');
    expect(r.stdout).toBe('');
  });

  it('denies bare sudo too — there is no interactive prompt to rubber-stamp', async () => {
    const r = await sandbox.exec('sudo');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe(SUDO_DENIED_MESSAGE);
  });

  it('emits approval:request so hosts can observe the attempt', async () => {
    const attempts: Array<{ verb: string; target?: string }> = [];
    events.on('approval:request', (e) => attempts.push({ verb: e.verb, target: e.target }));
    await sandbox.exec('sudo apt-get install nmap');
    expect(attempts).toEqual([{ verb: 'sudo', target: 'apt-get install nmap' }]);
  });

  it('does not escape via pipelines or command substitution', async () => {
    const r = await sandbox.exec('echo start && sudo whoami && echo end');
    expect(r.stdout).toContain('start');
    expect(r.stdout).not.toContain('end'); // && chain stops at the denial
    expect(r.stderr).toContain('EPERM');
  });
});
