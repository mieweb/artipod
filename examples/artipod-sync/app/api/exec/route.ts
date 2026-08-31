/**
 * POST /api/exec — server-side sandbox exec. Generic handler + validation
 * live in @artipod/core/server; THIS deployment's policy numbers below.
 * Body: { sessionId, command } → { stdout, stderr, exitCode, cwd }.
 * Set EXEC_API_TOKEN to require `Authorization: Bearer <token>`
 * (recommended — this endpoint is arbitrary compute).
 */
import { PodSessionHost } from '@artipod/core/manager';
import { bearerAuth, createExecSessionHandler } from '@artipod/core/server';

export const runtime = 'nodejs';

const handler = createExecSessionHandler({
  host: new PodSessionHost({
    ttlMs: 15 * 60 * 1000,
    maxSessions: 50,
    execTimeoutMs: 30_000,
    maxFsBytes: 256 * 1024 * 1024,
  }),
  auth: bearerAuth(() => process.env.EXEC_API_TOKEN),
});

export async function POST(req: Request): Promise<Response> {
  return handler(req);
}
