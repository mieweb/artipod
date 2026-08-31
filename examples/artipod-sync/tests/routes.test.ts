/**
 * Deployment wiring smoke tests: the Next routes are option-building
 * one-liners over @artipod/core/server handlers (sync plan Phase B) —
 * the generic behaviors are covered by package tests; here we pin THIS
 * app's wiring (policy env vars, store dir, session policy).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The pods store singleton (lib/pods-store) reads this once — pin it before
// any route import.
const STORE_DIR = mkdtempSync(join(tmpdir(), 'pods-store-'));
process.env.ARTIPOD_STORE_DIR = STORE_DIR;

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
    const { GET } = await import('../app/api/pods/[...path]/route');
    const res = await GET(new Request('http://localhost/api/pods/refs'), { params: { path: ['refs'] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('publishes a folder under ARTIPOD_PUBLISH_ROOTS and refuses one outside', async () => {
    const root = mkdtempSync(join(tmpdir(), 'publish-root-'));
    mkdirSync(join(root, 'site'));
    writeFileSync(join(root, 'site', 'index.md'), '# hello\n');
    process.env.ARTIPOD_PUBLISH_ROOTS = root;
    try {
      const { POST } = await import('../app/api/pods/publish/route');
      const publish = await POST(
        new Request('http://localhost/api/pods/publish', {
          method: 'POST',
          body: JSON.stringify({ dir: join(root, 'site'), ref: 'folder/site:latest' }),
        }),
      );
      expect(publish.status).toBe(201);
      const body = (await publish.json()) as { layers: number; unchanged: boolean };
      expect(body.layers).toBe(1);

      const outside = await POST(
        new Request('http://localhost/api/pods/publish', {
          method: 'POST',
          body: JSON.stringify({ dir: tmpdir(), ref: 'folder/evil:latest' }),
        }),
      );
      expect(outside.status).toBe(403);

      // The published ref shows up on the sync surface (same store).
      const { GET } = await import('../app/api/pods/[...path]/route');
      const refs = await GET(new Request('http://localhost/api/pods/refs'), { params: { path: ['refs'] } });
      const list = (await refs.json()) as { ref: string }[];
      expect(list.some((r) => r.ref === 'folder/site:latest')).toBe(true);
    } finally {
      delete process.env.ARTIPOD_PUBLISH_ROOTS;
    }
  });

  it('publish is disabled when ARTIPOD_PUBLISH_ROOTS is unset', async () => {
    delete process.env.ARTIPOD_PUBLISH_ROOTS;
    const { POST } = await import('../app/api/pods/publish/route');
    const res = await POST(
      new Request('http://localhost/api/pods/publish', {
        method: 'POST',
        body: JSON.stringify({ dir: tmpdir(), ref: 'folder/x' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('a ref PUT materializes back into the published folder (sync plan Phase E)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'writeback-root-'));
    mkdirSync(join(root, 'site'));
    writeFileSync(join(root, 'site', 'index.md'), '# restore me\n');
    process.env.ARTIPOD_PUBLISH_ROOTS = root;
    try {
      const { POST } = await import('../app/api/pods/publish/route');
      const publish = await POST(
        new Request('http://localhost/api/pods/publish', {
          method: 'POST',
          body: JSON.stringify({ dir: join(root, 'site'), ref: 'folder/wb:latest' }),
        }),
      );
      const { manifestDigest } = (await publish.json()) as { manifestDigest: string };

      rmSync(join(root, 'site', 'index.md')); // drift the folder…
      const { PUT } = await import('../app/api/pods/[...path]/route');
      const put = await PUT(
        new Request('http://localhost/api/pods/refs', {
          method: 'PUT',
          body: JSON.stringify({ ref: 'folder/wb:latest', manifestDigest }),
        }),
        { params: { path: ['refs'] } },
      );
      expect(put.status).toBe(201);
      // …the onRefPut hook restores it from the pushed head.
      expect(readFileSync(join(root, 'site', 'index.md'), 'utf8')).toBe('# restore me\n');
    } finally {
      delete process.env.ARTIPOD_PUBLISH_ROOTS;
    }
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
