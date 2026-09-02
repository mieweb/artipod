/**
 * Self-hosted git CORS proxy: /api/git/<host>/<repo-path>/<git-endpoint>.
 * Removes the dependency on cors.isomorphic-git.org — point the browser at
 * it via NEXT_PUBLIC_GIT_CORS_PROXY=/api/git. Validation/filtering live in
 * @artipod/core/server; the allowlist (GIT_PROXY_ALLOWED_HOSTS) is this
 * deployment's policy.
 */
import { allowedHosts, createGitProxyHandler } from '@artipod/core/server';

export const runtime = 'nodejs';

const handler = createGitProxyHandler({ allowlist: allowedHosts(process.env.GIT_PROXY_ALLOWED_HOSTS) });

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  return handler(req, (await params).path ?? []);
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
  return handler(req, (await params).path ?? []);
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handler(req, []);
}
