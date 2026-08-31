/**
 * Server exec sessions: pipeline round-trip, per-session isolation (files
 * from one session invisible to another), validation, busy guard.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { execInSession, resetSessions, sessionCount } from './exec-sessions';

beforeEach(() => {
  resetSessions();
});

describe('execInSession', () => {
  it('round-trips a pipeline with git available', async () => {
    const r = await execInSession('alice', 'echo -e "b\\na\\nc" | sort | head -2');
    expect(r.status).toBe(200);
    if ('error' in r.body) throw new Error(r.body.error);
    expect(r.body.stdout).toBe('a\nb\n');
    expect(r.body.exitCode).toBe(0);
    expect(r.body.cwd).toBe('/repo');

    const gitHelp = await execInSession('alice', 'git');
    expect(gitHelp.status).toBe(200);
    if ('error' in gitHelp.body) throw new Error(gitHelp.body.error);
    expect(gitHelp.body.stderr).toMatch(/usage: git/);
  });

  it('keeps cwd and files per session, invisible across sessions', async () => {
    await execInSession('alice', 'mkdir sub && cd sub && echo secret > s.txt');
    const aliceCwd = await execInSession('alice', 'pwd');
    if ('error' in aliceCwd.body) throw new Error(aliceCwd.body.error);
    expect(aliceCwd.body.stdout.trim()).toBe('/repo/sub');

    const bob = await execInSession('bob', 'ls /repo && cat /repo/sub/s.txt');
    if ('error' in bob.body) throw new Error(bob.body.error);
    expect(bob.body.stdout).not.toMatch(/s\.txt|secret/);
    expect(bob.body.exitCode).not.toBe(0); // cat fails: file does not exist for bob

    // alice still sees it
    const alice = await execInSession('alice', 'cat /repo/sub/s.txt');
    if ('error' in alice.body) throw new Error(alice.body.error);
    expect(alice.body.stdout).toBe('secret\n');
    expect(sessionCount()).toBe(2);
  });

  it('validates session ids and commands', async () => {
    expect((await execInSession('../etc', 'ls')).status).toBe(400);
    expect((await execInSession('a b', 'ls')).status).toBe(400);
    expect((await execInSession(42, 'ls')).status).toBe(400);
    expect((await execInSession('ok', '')).status).toBe(400);
    expect((await execInSession('ok', 'x'.repeat(200_000))).status).toBe(413);
  });

  it('rejects concurrent commands on one session with 429', async () => {
    const slow = execInSession('carol', 'for i in $(seq 1 2000); do echo $i > f.txt; done');
    const second = await execInSession('carol', 'echo fast');
    const first = await slow;
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});
