/**
 * node:http adapter for an ArtipodApp (serve plan S0, §3.2). Zero deps on
 * Node ≥20: IncomingMessage → Request (half-duplex streamed body),
 * Response → res via Readable.fromWeb — blob bodies are never buffered,
 * and Range/Content-Range pass through untouched.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { ArtipodApp } from './app.js';

export interface ServeAppOptions {
  /** Default 2784 ("ARTI" on a keypad, V7). 0 = OS-assigned. */
  port?: number;
  /** Default 127.0.0.1 (V7). */
  host?: string;
}

export interface RunningServer {
  /** The reachable base URL (real port even when 0 was asked for). */
  url: string;
  server: Server;
  close(): Promise<void>;
}

function toRequest(req: IncomingMessage, fallbackHost: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(`http://${req.headers.host ?? fallbackHost}${req.url ?? '/'}`, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as BodyInit) : undefined,
    // duplex is required by undici for streamed request bodies; not in lib.dom yet
    ...({ duplex: 'half' } as object),
  });
}

async function dispatch(app: ArtipodApp, req: IncomingMessage, res: ServerResponse, fallbackHost: string): Promise<void> {
  let response: Response;
  try {
    response = await app(toRequest(req, fallbackHost));
  } catch (e) {
    response = Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body && (req.method ?? 'GET').toUpperCase() !== 'HEAD') {
    Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>).pipe(res);
  } else {
    res.end();
  }
}

/** Node req/res adapter: mount an ArtipodApp in Express or node:http (dry plan E1). */
export function toNodeHandler(app: ArtipodApp): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void dispatch(app, req, res, req.headers.host ?? 'localhost');
  };
}

/** Bind an ArtipodApp on node:http. Resolves once listening; `close` drops keep-alive sockets too. */
export async function serveApp(app: ArtipodApp, options: ServeAppOptions = {}): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const handler = toNodeHandler(app);
  const server = createServer((req, res) => {
    req.headers.host ??= host;
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 2784, host, resolve);
  });
  const addr = server.address() as AddressInfo;
  const urlHost =
    host === '0.0.0.0' || host === '::' ? 'localhost' : addr.family === 'IPv6' ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${addr.port}`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
