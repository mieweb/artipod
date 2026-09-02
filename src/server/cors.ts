/**
 * CORS wrapper for the app's fetch-style handlers (serve plan S0).
 * Exact-origin allowlist, default EMPTY = deny (no CORS headers at all —
 * same posture as the relay/git allowlists). The git proxy keeps its own
 * `*` behavior (isomorphic-git requires it); this wrapper covers pods,
 * the relay, and later /v2/. The shipped UI is same-origin and never
 * needs any of this.
 */

import type { PathHandler } from './common.js';

const ALLOW_METHODS = 'GET, HEAD, PUT, POST, DELETE, OPTIONS';
const ALLOW_HEADERS = 'authorization, content-type, accept, range';
/** Docker-Content-Digest and Content-Range per plan §3.1. */
const EXPOSE_HEADERS = 'Docker-Content-Digest, Content-Range, Content-Length, Location';

function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': ALLOW_METHODS,
    'access-control-allow-headers': ALLOW_HEADERS,
    'access-control-expose-headers': EXPOSE_HEADERS,
    vary: 'Origin',
  };
}

/** Wrap a handler with exact-match origin CORS. Empty allowlist = passthrough (deny by default). */
export function withCors(handler: PathHandler, origins: Iterable<string>): PathHandler {
  const allowed = new Set([...origins].map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean));
  if (allowed.size === 0) return handler;
  return async (req, path) => {
    const origin = req.headers.get('origin');
    const allow = origin !== null && allowed.has(origin);
    if (req.method.toUpperCase() === 'OPTIONS') {
      // Preflight answered locally; a disallowed origin gets no CORS headers.
      return new Response(null, { status: allow ? 204 : 403, headers: allow ? corsHeaders(origin) : undefined });
    }
    const res = await handler(req, path);
    if (!allow) return res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}
