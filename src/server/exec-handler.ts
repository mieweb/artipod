/**
 * Exec-session HTTP surface over a PodSessionHost (sync plan Phase B;
 * graduated from artipod-sync's lib/server/exec-sessions). The generic
 * validation and HTTP shape live here; the deployment supplies the host
 * (with its policy numbers) and an auth hook.
 */

import type { PodSessionHost } from '../manager/session-host.js';
import { SESSION_ID_PATTERN } from '../manager/session-host.js';
import { authorizeAccess, json, type AuthHook } from './common.js';

export const DEFAULT_MAX_COMMAND_LENGTH = 100_000;

export interface ExecRequestResult {
  status: number;
  body:
    | { stdout: string; stderr: string; exitCode: number; cwd: string }
    | { error: string };
}

/** Framework-free core of POST /exec — handlers and tests call this directly. */
export async function execInSession(
  host: PodSessionHost,
  sessionId: unknown,
  command: unknown,
  maxCommandLength = DEFAULT_MAX_COMMAND_LENGTH,
): Promise<ExecRequestResult> {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return { status: 400, body: { error: 'sessionId must match [A-Za-z0-9_-]{1,64}' } };
  }
  if (typeof command !== 'string' || !command.trim()) {
    return { status: 400, body: { error: 'command must be a non-empty string' } };
  }
  if (command.length > maxCommandLength) {
    return { status: 413, body: { error: 'command too long' } };
  }

  const result = await host.exec(sessionId, command);
  if (!result.ok) {
    return { status: result.status, body: { error: result.message } };
  }
  return {
    status: 200,
    body: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, cwd: result.cwd },
  };
}

export interface ExecSessionHandlerOptions {
  host: PodSessionHost;
  auth?: AuthHook;
  maxCommandLength?: number;
}

/** POST body: { sessionId, command } → { stdout, stderr, exitCode, cwd }. */
export function createExecSessionHandler(options: ExecSessionHandlerOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    // exec is arbitrary compute — always a write
    const denied = await authorizeAccess(req, options.auth, 'rw');
    if (denied) return denied;

    let payload: { sessionId?: unknown; command?: unknown };
    try {
      payload = (await req.json()) as typeof payload;
    } catch {
      return json({ error: 'invalid JSON body' }, 400);
    }

    const { status, body } = await execInSession(
      options.host,
      payload.sessionId,
      payload.command,
      options.maxCommandLength,
    );
    return json(body, status);
  };
}
