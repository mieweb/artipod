import { beforeEach, describe, expect, it } from 'vitest';
import { catalogStore, refreshServer, type ServerRef } from '../lib/stores/catalog';

const REF: ServerRef = {
  ref: 'doug:_1',
  manifestDigest: 'sha256:abc',
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  pulledAt: '2026-09-03T00:00:00Z',
  encrypted: true,
};

const fakeFetch = (handler: () => Promise<Response> | Response): typeof fetch =>
  ((async () => handler()) as unknown) as typeof fetch;

describe('catalogStore.refreshServer', () => {
  beforeEach(() => {
    catalogStore.setState({ status: 'idle', serverRefs: null, error: undefined, localHeads: {}, verdicts: {}, changedRefs: [] }, true);
  });

  it('round-trips refs and filters the artipod-ui infrastructure artifact', async () => {
    const uiRef = { ...REF, ref: 'artipod-ui:latest' };
    await refreshServer(fakeFetch(() => new Response(JSON.stringify([REF, uiRef]), { status: 200 })));
    expect(catalogStore.getState().status).toBe('ready');
    expect(catalogStore.getState().serverRefs).toEqual([REF]);
  });

  it('failed fetches are recorded, not memoized', async () => {
    await refreshServer(fakeFetch(() => new Response('nope', { status: 500 })));
    expect(catalogStore.getState().status).toBe('error');
    expect(catalogStore.getState().error).toContain('500');
    await refreshServer(fakeFetch(() => new Response(JSON.stringify([]), { status: 200 })));
    expect(catalogStore.getState().status).toBe('ready');
    expect(catalogStore.getState().error).toBeUndefined();
  });
});
