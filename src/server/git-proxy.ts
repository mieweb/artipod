/**
 * Git CORS proxy — validation + header filtering (a port of the
 * @isomorphic-git/cors-proxy rules) and the fetch-style handler over them
 * (sync plan Phase B; graduated from artipod-sync's lib/server/git-proxy).
 *
 * Egress control for git (which bypasses just-bash's network firewall by
 * design): only allowlisted hosts, only smart-HTTP endpoints.
 */

import { json, type PathHandler } from './common.js';

export const DEFAULT_ALLOWED_HOSTS = [
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'codeberg.org',
  'gitea.com',
];

export function allowedHosts(env: string | undefined = process.env.GIT_PROXY_ALLOWED_HOSTS): string[] {
  if (!env) return DEFAULT_ALLOWED_HOSTS;
  return env
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

const GIT_SERVICES = ['git-upload-pack', 'git-receive-pack'];

export type ProxyValidation =
  | { ok: true; upstream: string }
  | { ok: false; status: number; message: string };

/**
 * Validate `<host>/<repo-path>/<git-endpoint>` against the smart-HTTP shape:
 *   GET  .../info/refs?service=git-upload-pack|git-receive-pack
 *   POST .../git-upload-pack | .../git-receive-pack
 */
export function validateProxyRequest(
  method: string,
  segments: string[],
  searchParams: URLSearchParams,
  hosts: string[] = allowedHosts(),
): ProxyValidation {
  if (segments.length < 2) {
    return { ok: false, status: 400, message: 'expected /<host>/<path>' };
  }
  const [host, ...rest] = segments;
  if (!hosts.includes(host.toLowerCase())) {
    return { ok: false, status: 403, message: `host not allowed: ${host}` };
  }
  if (rest.some((s) => s === '..' || s === '.' || s === '')) {
    return { ok: false, status: 400, message: 'invalid path' };
  }
  const path = rest.join('/');

  if (method === 'GET') {
    const service = searchParams.get('service') ?? '';
    if (!path.endsWith('/info/refs') || !GIT_SERVICES.includes(service)) {
      return { ok: false, status: 403, message: 'only smart-HTTP info/refs requests are allowed' };
    }
    return { ok: true, upstream: `https://${host}/${path}?service=${service}` };
  }

  if (method === 'POST') {
    if (!GIT_SERVICES.some((s) => path.endsWith(`/${s}`))) {
      return { ok: false, status: 403, message: 'only git-upload-pack/git-receive-pack POSTs are allowed' };
    }
    return { ok: true, upstream: `https://${host}/${path}` };
  }

  return { ok: false, status: 405, message: 'method not allowed' };
}

const REQUEST_HEADER_ALLOWLIST = [
  'accept',
  'accept-encoding',
  'accept-language',
  'authorization',
  'content-type',
  'git-protocol',
  'pragma',
  'user-agent',
];

const RESPONSE_HEADER_ALLOWLIST = [
  'content-type',
  'content-length',
  'cache-control',
  'expires',
  'pragma',
  'vary',
  'www-authenticate',
  'x-github-request-id',
];

export function filterRequestHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = incoming.get(name);
    if (value) out.set(name, value);
  }
  return out;
}

export function filterResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = upstream.get(name);
    if (value) out.set(name, value);
  }
  // CORS so pure-static deployments can point at a hosted proxy.
  out.set('Access-Control-Allow-Origin', '*');
  out.set('Access-Control-Allow-Headers', REQUEST_HEADER_ALLOWLIST.join(', '));
  out.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return out;
}

export interface GitProxyHandlerOptions {
  /** Defaults to allowedHosts() — the env-driven list. */
  allowlist?: string[];
  fetchFn?: typeof fetch;
}

export function createGitProxyHandler(options: GitProxyHandlerOptions = {}): PathHandler {
  const hosts = options.allowlist ?? allowedHosts();
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  return async (req, segments) => {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: filterResponseHeaders(new Headers()) });
    }
    const url = new URL(req.url);
    const validation = validateProxyRequest(req.method, segments, url.searchParams, hosts);
    if (!validation.ok) {
      return json({ error: validation.message }, validation.status);
    }
    const upstream = await fetchFn(validation.upstream, {
      method: req.method,
      headers: filterRequestHeaders(req.headers),
      body: req.method === 'POST' ? await req.arrayBuffer() : undefined,
      redirect: 'follow',
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: filterResponseHeaders(upstream.headers),
    });
  };
}
