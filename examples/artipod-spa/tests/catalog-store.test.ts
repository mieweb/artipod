import { beforeEach, describe, expect, it } from 'vitest';
import { catalogStore, type ServerRef } from '../lib/stores/catalog';

const REF: ServerRef = {
  ref: 'doug:_1',
  manifestDigest: 'sha256:abc',
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  pulledAt: '2026-09-03T00:00:00Z',
  encrypted: true,
};

const fakeFetch = (handler: () => Promise<Response> | Response): typeof fetch =>
  ((async () => handler()) as unknown) as typeof fetch;

describe('catalogStore (vanilla, no React)', () => {
  beforeEach(() => {
    catalogStore.setState({ status: 'idle', refs: [], error: undefined });
  });

  it('round-trips refs through refreshServer', async () => {
    const seen: string[] = [];
    catalogStore.subscribe((s) => seen.push(s.status));
    await catalogStore
      .getState()
      .refreshServer(fakeFetch(() => new Response(JSON.stringify([REF]), { status: 200 })));
    expect(catalogStore.getState().status).toBe('ready');
    expect(catalogStore.getState().refs).toEqual([REF]);
    expect(seen).toEqual(['loading', 'ready']);
  });

  it('failed fetches are recorded, not memoized', async () => {
    await catalogStore.getState().refreshServer(fakeFetch(() => new Response('nope', { status: 500 })));
    expect(catalogStore.getState().status).toBe('error');
    expect(catalogStore.getState().error).toContain('500');

    await catalogStore
      .getState()
      .refreshServer(fakeFetch(() => new Response(JSON.stringify([]), { status: 200 })));
    expect(catalogStore.getState().status).toBe('ready');
    expect(catalogStore.getState().error).toBeUndefined();
  });
});
