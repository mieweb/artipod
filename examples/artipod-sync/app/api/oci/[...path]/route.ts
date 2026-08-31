/**
 * /api/oci/<host>/<path> — the registry relay for browser pods (plan
 * Phase 4, Decision #4): GET-only, headers filtered both ways, blobs
 * verify by digest client-side. Handler lives in @artipod/core/server;
 * the allowlist is injected here via ARTIPOD_OCI_ALLOWED_HOSTS and
 * DEFAULTS TO EMPTY = deny all.
 */
import { createRegistryRelayHandler } from '@artipod/core/server';

export const dynamic = 'force-dynamic';

const handler = createRegistryRelayHandler({
  allowedHosts: (process.env.ARTIPOD_OCI_ALLOWED_HOSTS ?? '').split(','),
});

export async function GET(req: Request, { params }: { params: { path: string[] } }): Promise<Response> {
  return handler(req, params.path ?? []);
}
