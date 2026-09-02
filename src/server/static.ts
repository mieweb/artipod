/**
 * Traversal-safe static file serving for the shipped UI (serve plan S2).
 * Node-only. Root-relative resolution, a small content-type map, and
 * `index.html` SPA fallback for extensionless routes.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve, sep, extname } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

async function tryFile(path: string): Promise<Uint8Array | null> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return null;
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

/** Serve files under `dir`; unknown extensionless paths fall back to index.html (SPA). */
export function createStaticHandler(dir: string): (req: Request) => Promise<Response> {
  const root = resolve(dir);
  return async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return Response.json({ error: 'method not allowed' }, { status: 405 });
    }
    const pathname = decodeURIComponent(new URL(req.url).pathname);
    // normalize + prefix check = no `..` escape
    const target = normalize(join(root, pathname));
    if (target !== root && !target.startsWith(root + sep)) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }

    const candidates = [
      target,
      // Next static export spellings: /page → page.html, /dir → dir/index.html
      pathname.endsWith('/') ? join(target, 'index.html') : `${target}.html`,
      join(target, 'index.html'),
    ];
    for (const candidate of candidates) {
      const bytes = await tryFile(candidate);
      if (bytes) {
        const type = CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream';
        return new Response(req.method === 'HEAD' ? null : (bytes as BodyInit), {
          headers: { 'content-type': type, 'content-length': String(bytes.length) },
        });
      }
    }
    // SPA fallback: only for navigations, never for missing assets
    if (!extname(pathname)) {
      const index = await tryFile(join(root, 'index.html'));
      if (index) {
        return new Response(req.method === 'HEAD' ? null : (index as BodyInit), {
          headers: { 'content-type': CONTENT_TYPES['.html'], 'content-length': String(index.length) },
        });
      }
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
}
