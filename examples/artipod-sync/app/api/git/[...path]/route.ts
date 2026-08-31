/**
 * Self-hosted git CORS proxy: /api/git/<host>/<repo-path>/<git-endpoint>.
 * Removes the dependency on cors.isomorphic-git.org — point the browser at
 * it via NEXT_PUBLIC_GIT_CORS_PROXY=/api/git. Only allowlisted hosts and
 * smart-HTTP endpoints pass (lib/server/git-proxy.ts).
 */
import {
  filterRequestHeaders,
  filterResponseHeaders,
  validateProxyRequest,
} from '@/lib/server/git-proxy';

export const runtime = 'nodejs';

async function proxy(req: Request, segments: string[]): Promise<Response> {
  const url = new URL(req.url);
  const validation = validateProxyRequest(req.method, segments, url.searchParams);
  if (!validation.ok) {
    return Response.json({ error: validation.message }, { status: validation.status });
  }

  const upstream = await fetch(validation.upstream, {
    method: req.method,
    headers: filterRequestHeaders(req.headers),
    body: req.method === 'POST' ? await req.arrayBuffer() : undefined,
    redirect: 'follow',
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: filterResponseHeaders(upstream.headers),
  });
}

type Ctx = { params: { path: string[] } };

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  return proxy(req, params.path ?? []);
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  return proxy(req, params.path ?? []);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: filterResponseHeaders(new Headers()) });
}
