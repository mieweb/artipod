import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256, writeTar } from '@artipod/core/oci';
import { inspectPublishedApplication } from './executable-catalog';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const descriptor = encode({ apiVersion: 'artipod.io/v1', kind: 'SPAPod', metadata: { name: 'Listed app' }, spec: { entrypoint: 'index.html' } });
async function repository(entries: { path: string; content: Uint8Array }[][]) {
  const blobs = new Map<string, Uint8Array>();
  const layers = [];
  for (const group of entries) {
    const bytes = writeTar(group.map(entry => ({ ...entry, type: 'file' as const, mode: 0o644, mtimeMs: 0 })));
    const digest = await sha256(bytes);
    blobs.set(digest, bytes);
    layers.push({ digest, size: bytes.length });
  }
  const manifest = encode({ schemaVersion: 2, layers });
  const digest = await sha256(manifest);
  blobs.set(digest, manifest);
  const fetcher = vi.fn(async (url: string) => {
    const bytes = blobs.get(url.slice('/api/pods/blobs/'.length));
    return bytes ? new Response(bytes as BodyInit) : new Response(null, { status: 423 });
  });
  vi.stubGlobal('fetch', fetcher);
  return { digest, blobs, fetcher };
}
afterEach(() => vi.unstubAllGlobals());

describe('inert OCI executable discovery', () => {
  it('classifies the descriptor without executing or requiring an entrypoint fetch', async () => {
    const { digest } = await repository([[{ path: 'artipod.json', content: descriptor }]]);
    expect(await inspectPublishedApplication(digest)).toMatchObject({ name: 'Listed app', entrypoint: 'index.html' });
  });
  it('honors descriptor deletion and replacement in later layers', async () => {
    const removed = await repository([[{ path: 'artipod.json', content: descriptor }], [{ path: '.wh.artipod.json', content: new Uint8Array() }]]);
    expect(await inspectPublishedApplication(removed.digest)).toBeNull();
    const replaced = await repository([[{ path: 'artipod.json', content: descriptor }], [{ path: 'artipod.json', content: encode({ kind: 'CasePod' }) }]]);
    await expect(inspectPublishedApplication(replaced.digest)).rejects.toThrow();
  });
  it('rejects tampered and locked manifests', async () => {
    const { digest, blobs } = await repository([]);
    blobs.set(digest, encode({ layers: [] }));
    await expect(inspectPublishedApplication(digest)).rejects.toThrow();
    blobs.clear();
    await expect(inspectPublishedApplication(digest)).rejects.toThrow('423');
  });
  it('does not pull oversized layers just to classify a listing', async () => {
    const { digest, fetcher } = await repository([[{ path: 'large.bin', content: new Uint8Array(300 * 1024) }]]);
    expect(await inspectPublishedApplication(digest)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});