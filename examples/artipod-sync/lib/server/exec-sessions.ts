/**
 * Per-session server sandboxes — a thin policy wrapper over
 * @artipod/core/manager's PodSessionHost (plan Phase 6, Decision #2: the
 * generic pod/session hosting lives in the package; THIS deployment's
 * numbers and HTTP shape live here).
 */
import { PodSessionHost, SESSION_ID_PATTERN } from '@artipod/core/manager';

export { SESSION_ID_PATTERN };
export const MAX_COMMAND_LENGTH = 100_000;

const host = new PodSessionHost({
  ttlMs: 15 * 60 * 1000,
  maxSessions: 50,
  execTimeoutMs: 30_000,
  maxFsBytes: 256 * 1024 * 1024,
});

export interface ExecRequestResult {
  status: number;
  body:
    | { stdout: string; stderr: string; exitCode: number; cwd: string }
    | { error: string };
}

/** Framework-free core of POST /api/exec — the route is a thin wrapper. */
export async function execInSession(sessionId: unknown, command: unknown): Promise<ExecRequestResult> {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    return { status: 400, body: { error: 'sessionId must match [A-Za-z0-9_-]{1,64}' } };
  }
  if (typeof command !== 'string' || !command.trim()) {
    return { status: 400, body: { error: 'command must be a non-empty string' } };
  }
  if (command.length > MAX_COMMAND_LENGTH) {
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

export function sessionCount(): number {
  return host.size;
}

/** Test helper. */
export function resetSessions(): void {
  host.reset();
}
