import { NextResponse } from 'next/server';

/**
 * /api/oci/<host>/<path> — the registry relay for browser pods (plan
 * Phase 4, Decision #4): same posture as the git proxy. The host allowlist
 * is injected at initialization via ARTIPOD_OCI_ALLOWED_HOSTS and DEFAULTS
 * TO EMPTY = deny all. GET only; Accept/Authorization/Range pass through;
 * blobs verify by digest client-side, so this relay never needs trust.
 */
export const dynamic = 'force-dynamic';

const allowedHosts = new Set(
  (process.env.ARTIPOD_OCI_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

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

export async function GET(request: Request, { params }: { params: { path: string[] } }) {
  const [host, ...rest] = params.path ?? [];
  if (!host || !rest.length) {
    return NextResponse.json({ error: 'usage: /api/oci/<registry-host>/<path>' }, { status: 400 });
  }
  if (!allowedHosts.has(host.toLowerCase())) {
    return NextResponse.json(
      {
        error: `registry host '${host}' is not allowed`,
        hint: 'set ARTIPOD_OCI_ALLOWED_HOSTS (comma-separated); the default is deny-all',
      },
      { status: 403 },
    );
  }

  const search = new URL(request.url).search;
  const upstream = `https://${host}/${rest.map(encodeURIComponent).join('/')}${search}`;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const response = await fetch(upstream, { headers, redirect: 'follow' });
  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: out });
}
