/**
 * Exec sessions over PodSessionHost: pipeline round-trip, per-session
 * isolation, validation, busy guard (ported from artipod-sync's
 * lib/server suite in sync plan Phase B) + the handler's auth/JSON edges.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { PodSessionHost } from '../manager/session-host.js';
import { bearerAuth } from './common.js';
import { createExecSessionHandler, execInSession } from './exec-handler.js';

let host: PodSessionHost;

beforeEach(() => {
  host = new PodSessionHost({
    ttlMs: 15 * 60 * 1000,
    maxSessions: 50,
    execTimeoutMs: 30_000,
    maxFsBytes: 256 * 1024 * 1024,
    rootPrefix: `/exec-test-${Math.random().toString(36).slice(2)}`,
  });
});

describe('execInSession', () => {
  it('round-trips a pipeline with git available', async () => {
    const r = await execInSession(host, 'alice', 'echo -e "b\\na\\nc" | sort | head -2');
    expect(r.status).toBe(200);
    if ('error' in r.body) throw new Error(r.body.error);
    expect(r.body.stdout).toBe('a\nb\n');
    expect(r.body.exitCode).toBe(0);
    expect(r.body.cwd).toBe('/repo');

    const gitHelp = await execInSession(host, 'alice', 'git');
    expect(gitHelp.status).toBe(200);
    if ('error' in gitHelp.body) throw new Error(gitHelp.body.error);
    expect(gitHelp.body.stderr).toMatch(/usage: git/);
  });

  it('keeps cwd and files per session, invisible across sessions', async () => {
    await execInSession(host, 'alice', 'mkdir sub && cd sub && echo secret > s.txt');
    const aliceCwd = await execInSession(host, 'alice', 'pwd');
    if ('error' in aliceCwd.body) throw new Error(aliceCwd.body.error);
    expect(aliceCwd.body.stdout.trim()).toBe('/repo/sub');

    const bob = await execInSession(host, 'bob', 'ls /repo && cat /repo/sub/s.txt');
    if ('error' in bob.body) throw new Error(bob.body.error);
    expect(bob.body.stdout).not.toMatch(/s\.txt|secret/);
    expect(bob.body.exitCode).not.toBe(0); // cat fails: file does not exist for bob

    const alice = await execInSession(host, 'alice', 'cat /repo/sub/s.txt');
    if ('error' in alice.body) throw new Error(alice.body.error);
    expect(alice.body.stdout).toBe('secret\n');
    expect(host.size).toBe(2);
  });

  it('validates session ids and commands', async () => {
    expect((await execInSession(host, '../etc', 'ls')).status).toBe(400);
    expect((await execInSession(host, 'a b', 'ls')).status).toBe(400);
    expect((await execInSession(host, 42, 'ls')).status).toBe(400);
    expect((await execInSession(host, 'ok', '')).status).toBe(400);
    expect((await execInSession(host, 'ok', 'x'.repeat(200_000))).status).toBe(413);
  });

  it('rejects concurrent commands on one session with 429', async () => {
    // Warm the session so both execs contend on the busy flag, not on the
    // async session-creation path (fresh-host port of the app-suite test).
    await execInSession(host, 'carol', 'true');
    const slow = execInSession(host, 'carol', 'for i in $(seq 1 2000); do echo $i > f.txt; done');
    const second = await execInSession(host, 'carol', 'echo fast');
    const first = await slow;
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});

describe('createExecSessionHandler', () => {
  const post = (body: BodyInit, headers?: HeadersInit) =>
    new Request('http://x/api/exec', { method: 'POST', body, headers });

  it('executes with a valid bearer, 401s without, 400s bad JSON', async () => {
    const handler = createExecSessionHandler({ host, auth: bearerAuth(() => 'token-1') });

    const denied = await handler(post(JSON.stringify({ sessionId: 's', command: 'echo hi' })));
    expect(denied.status).toBe(401);

    const ok = await handler(
      post(JSON.stringify({ sessionId: 's', command: 'echo hi' }), { authorization: 'Bearer token-1' }),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { stdout: string }).stdout).toBe('hi\n');

    const bad = await handler(post('{nope', { authorization: 'Bearer token-1' }));
    expect(bad.status).toBe(400);
  });

  it('is open when the token thunk returns undefined', async () => {
    const handler = createExecSessionHandler({ host, auth: bearerAuth(() => undefined) });
    const r = await handler(post(JSON.stringify({ sessionId: 's', command: 'pwd' })));
    expect(r.status).toBe(200);
  });
});
