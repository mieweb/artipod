/**
 * Registry relay: deny-all default, allowlist, GET-only, header filtering
 * both directions (graduated from the artipod-sync /api/oci route).
 */
import { describe, expect, it } from 'vitest';
import { createRegistryRelayHandler } from './registry-relay.js';

describe('createRegistryRelayHandler', () => {
  it('denies everything with an empty allowlist (the default posture)', async () => {
    const handler = createRegistryRelayHandler({ allowedHosts: [] });
    const res = await handler(new Request('http://x/api/oci/registry-1.docker.io/v2/'), [
      'registry-1.docker.io',
      'v2',
    ]);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { hint: string }).hint).toMatch(/deny-all/);
  });

  it('forwards allowed hosts with filtered headers, preserving the query', async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const handler = createRegistryRelayHandler({
      allowedHosts: ['Registry-1.Docker.io'],
      fetchFn: async (input, init) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) });
        return new Response('blob-bytes', {
          status: 206,
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': 'bytes 5-9/10',
            'x-internal-backend': 'leak-me-not',
          },
        });
      },
    });

    const req = new Request('http://x/api/oci/registry-1.docker.io/v2/library/alpine/blobs/sha256%3Aabc?from=cache', {
      headers: { range: 'bytes=5-', authorization: 'Bearer tok', 'x-custom': 'strip' },
    });
    const res = await handler(req, ['registry-1.docker.io', 'v2', 'library', 'alpine', 'blobs', 'sha256:abc']);

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 5-9/10');
    expect(res.headers.get('x-internal-backend')).toBeNull();
    expect(calls[0].url).toBe('https://registry-1.docker.io/v2/library/alpine/blobs/sha256%3Aabc?from=cache');
    expect(calls[0].headers.get('range')).toBe('bytes=5-');
    expect(calls[0].headers.get('authorization')).toBe('Bearer tok');
    expect(calls[0].headers.get('x-custom')).toBeNull();
  });

  it('answers non-GET with 405 and malformed paths with usage 400', async () => {
    const handler = createRegistryRelayHandler({ allowedHosts: ['ghcr.io'] });
    expect((await handler(new Request('http://x/y', { method: 'POST' }), ['ghcr.io', 'v2'])).status).toBe(405);
    expect((await handler(new Request('http://x/y'), ['ghcr.io'])).status).toBe(400);
    expect((await handler(new Request('http://x/y'), [])).status).toBe(400);
  });
});
