/**
 * OCI registry relay for browser pods (sync plan Phase B; graduated from
 * artipod-sync's /api/oci route — plan Phase 4, Decision #4). Same posture
 * as the git proxy: the host allowlist is injected at initialization and
 * DEFAULTS TO EMPTY = deny all. GET only; Accept/Authorization/Range pass
 * through; blobs verify by digest client-side, so the relay never needs
 * trust. Pair with ArtipodRegistryProxyTransport on the browser side.
 */

import { json, type PathHandler } from './common.js';

const FORWARDED_REQUEST_HEADERS = ['accept', 'authorization', 'range'] as const;
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'docker-content-digest',
  'www-authenticate',
  'location',
] as const;

export interface RegistryRelayHandlerOptions {
  /** Registry hosts the relay may reach. Empty = deny all (the default posture). */
  allowedHosts: Iterable<string>;
  fetchFn?: typeof fetch;
}

export function createRegistryRelayHandler(options: RegistryRelayHandlerOptions): PathHandler {
  const hosts = new Set([...options.allowedHosts].map((h) => h.trim().toLowerCase()).filter(Boolean));
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  return async (req, path) => {
    if (req.method.toUpperCase() !== 'GET') {
      return json({ error: 'method not allowed' }, 405);
    }
    const [host, ...rest] = path;
    if (!host || !rest.length) {
      return json({ error: 'usage: <base>/<registry-host>/<path>' }, 400);
    }
    if (!hosts.has(host.toLowerCase())) {
      return json(
        {
          error: `registry host '${host}' is not allowed`,
          hint: 'the allowlist is injected at initialization; the default is deny-all',
        },
        403,
      );
    }

    const search = new URL(req.url).search;
    const upstream = `https://${host}/${rest.map(encodeURIComponent).join('/')}${search}`;

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers.get(name);
      if (value) headers.set(name, value);
    }

    const response = await fetchFn(upstream, { headers, redirect: 'follow' });
    const out = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: out });
  };
}
