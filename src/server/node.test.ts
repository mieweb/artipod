/**
 * node:http adapter (serve plan S0): request/response translation, streamed
 * bodies both ways, Range passthrough, --port 0, and clean close with
 * keep-alive sockets open.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { serveApp, type RunningServer } from './node.js';
import type { ArtipodApp } from './app.js';

let running: RunningServer | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});

const start = async (app: ArtipodApp): Promise<RunningServer> => {
  running = await serveApp(app, { port: 0 });
  return running;
};

describe('serveApp', () => {
  it('binds an OS-assigned port and translates method/url/headers/body', async () => {
    const seen: { method?: string; url?: string; header?: string | null; body?: string } = {};
    const { url } = await start(async (req) => {
      seen.method = req.method;
      seen.url = req.url;
      seen.header = req.headers.get('x-probe');
      seen.body = await req.text();
      return Response.json({ ok: true }, { status: 201 });
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await fetch(`${url}/some/path?q=1`, {
      method: 'PUT',
      headers: { 'x-probe': 'yes' },
      body: 'payload bytes',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen.method).toBe('PUT');
    expect(seen.url).toContain('/some/path?q=1');
    expect(seen.header).toBe('yes');
    expect(seen.body).toBe('payload bytes');
  });

  it('streams response bodies without buffering (chunked ReadableStream arrives intact)', async () => {
    const chunks = ['first-', 'second-', 'third'];
    const { url } = await start(async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const c of chunks) {
            controller.enqueue(new TextEncoder().encode(c));
            await new Promise((r) => setTimeout(r, 5));
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'application/octet-stream' } });
    });
    const res = await fetch(url);
    expect(await res.text()).toBe('first-second-third');
  });

  it('passes Range and Content-Range through untouched', async () => {
    const { url } = await start(async (req) => {
      const range = req.headers.get('range');
      if (range === 'bytes=5-') {
        return new Response('artipod', {
          status: 206,
          headers: { 'content-range': 'bytes 5-11/12' },
        });
      }
      return new Response('hello artipod');
    });
    const res = await fetch(url, { headers: { range: 'bytes=5-' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 5-11/12');
    expect(await res.text()).toBe('artipod');
  });

  it('HEAD requests get headers but no body', async () => {
    const { url } = await start(
      async () => new Response('body-bytes', { headers: { 'x-len': '10' } }),
    );
    const res = await fetch(url, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-len')).toBe('10');
    expect(await res.text()).toBe('');
  });

  it('an app that throws becomes a 500, not a hung socket', async () => {
    const { url } = await start(async () => {
      throw new Error('boom');
    });
    const res = await fetch(url);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('boom');
  });

  it('close() resolves even with a keep-alive socket open', async () => {
    const { url, close } = await start(async () => new Response('ok'));
    await fetch(url, { headers: { connection: 'keep-alive' } });
    await close();
    running = null;
    await expect(fetch(url)).rejects.toThrow();
  });
});
