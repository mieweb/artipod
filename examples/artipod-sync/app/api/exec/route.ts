/**
 * POST /api/exec — server-side sandbox exec.
 * Body: { sessionId, command } → { stdout, stderr, exitCode, cwd }.
 *
 * Sessions are isolated in-memory sandboxes (git included) with TTL
 * eviction; see lib/server/exec-sessions.ts. Optional bearer auth: set
 * EXEC_API_TOKEN to require `Authorization: Bearer <token>` (recommended —
 * this endpoint is arbitrary compute).
 */
import { execInSession } from '@/lib/server/exec-sessions';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const requiredToken = process.env.EXEC_API_TOKEN;
  if (requiredToken) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth !== `Bearer ${requiredToken}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  let payload: { sessionId?: unknown; command?: unknown };
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { status, body } = await execInSession(payload.sessionId, payload.command);
  return Response.json(body, { status });
}
