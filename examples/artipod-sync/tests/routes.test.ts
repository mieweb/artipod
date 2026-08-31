/**
 * Deployment wiring smoke tests: the Next routes are option-building
 * one-liners over @artipod/core/server handlers (sync plan Phase B) —
 * the generic behaviors are covered by package tests; here we pin THIS
 * app's wiring (policy env vars, store dir, session policy).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('route wiring', () => {
  it('POST /api/exec runs a command in a session with this deployment policy', async () => {
    const { POST } = await import('../app/api/exec/route');
    const res = await POST(
      new Request('http://localhost/api/exec', {
        method: 'POST',
        body: JSON.stringify({ sessionId: 'smoke', command: 'echo hi && pwd' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stdout: string; cwd: string };
    expect(body.stdout).toBe('hi\n/repo\n');
    expect(body.cwd).toBe('/repo');
  });

  it('honors EXEC_API_TOKEN at request time', async () => {
    const { POST } = await import('../app/api/exec/route');
    process.env.EXEC_API_TOKEN = 'shh';
    try {
      const denied = await POST(
        new Request('http://localhost/api/exec', {
          method: 'POST',
          body: JSON.stringify({ sessionId: 'smoke', command: 'echo hi' }),
        }),
      );
      expect(denied.status).toBe(401);
    } finally {
      delete process.env.EXEC_API_TOKEN;
    }
  });

  it('serves the pods store from ARTIPOD_STORE_DIR', async () => {
    process.env.ARTIPOD_STORE_DIR = mkdtempSync(join(tmpdir(), 'pods-store-'));
    const { GET } = await import('../app/api/pods/[...path]/route');
    const res = await GET(new Request('http://localhost/api/pods/refs'), { params: { path: ['refs'] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('OCI relay stays deny-all without ARTIPOD_OCI_ALLOWED_HOSTS', async () => {
    delete process.env.ARTIPOD_OCI_ALLOWED_HOSTS;
    const { GET } = await import('../app/api/oci/[...path]/route');
    const res = await GET(new Request('http://localhost/api/oci/registry-1.docker.io/v2/'), {
      params: { path: ['registry-1.docker.io', 'v2'] },
    });
    expect(res.status).toBe(403);
  });
});
