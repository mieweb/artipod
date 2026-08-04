/**
 * Per-session server sandboxes over one global in-memory ZenFS.
 *
 * Each session gets /sessions/<id> and a bindContext() chroot view, so git
 * works server-side identically to the browser while sessions stay mutually
 * invisible. This is just-bash's "untrusted script author" scenario: the
 * interpreter is the sandbox; we add the hardened limit profile, a per-fs
 * byte cap, an in-flight guard and TTL eviction on top.
 */
import { createSandbox } from '../sandbox';
import type { Sandbox, ZenFsLike } from '../sandbox/types';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_COMMAND_LENGTH = 100_000;

const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 50;
const EXEC_TIMEOUT_MS = 30_000;
const MAX_FS_BYTES = 256 * 1024 * 1024;

interface SessionEntry {
  sandbox: Sandbox;
  lastUsed: number;
  busy: boolean;
}

const sessions = new Map<string, SessionEntry>();
let fsReady: Promise<void> | null = null;

async function ensureGlobalFs(): Promise<void> {
  if (!fsReady) {
    fsReady = (async () => {
      const { configure, InMemory } = await import('@zenfs/core');
      try {
        await configure({ mounts: { '/': InMemory } });
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes('Mount point is already in use')) throw e;
      }
    })();
  }
  return fsReady;
}

export function evictExpired(now = Date.now()): void {
  sessions.forEach((entry, id) => {
    if (now - entry.lastUsed > SESSION_TTL_MS) sessions.delete(id);
  });
}

export type AcquireResult =
  | { ok: true; entry: SessionEntry }
  | { ok: false; status: number; message: string };

async function acquireSession(sessionId: string): Promise<AcquireResult> {
  await ensureGlobalFs();
  evictExpired();

  let entry = sessions.get(sessionId);
  if (!entry) {
    if (sessions.size >= MAX_SESSIONS) {
      return { ok: false, status: 503, message: 'session limit reached, try again later' };
    }
    const core = await import('@zenfs/core');
    const root = `/sessions/${sessionId}`;
    await core.fs.promises.mkdir(`${root}/repo`, { recursive: true });
    // another concurrent request may have created the session while we awaited
    const existing = sessions.get(sessionId);
    if (existing) {
      entry = existing;
    } else {
      const ctx = core.bindContext({ root });
      entry = {
        sandbox: createSandbox({
          zfs: ctx.fs as unknown as ZenFsLike,
          executionLimitProfile: 'hardened',
          executionLimits: { maxFileSystemBytes: MAX_FS_BYTES },
        }),
        lastUsed: Date.now(),
        busy: false,
      };
      sessions.set(sessionId, entry);
    }
  }
  if (entry.busy) {
    return { ok: false, status: 429, message: 'session is busy with another command' };
  }
  // Reserve synchronously — no await between the check and this line.
  entry.busy = true;
  entry.lastUsed = Date.now();
  return { ok: true, entry };
}

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

  const acquired = await acquireSession(sessionId);
  if (!acquired.ok) {
    return { status: acquired.status, body: { error: acquired.message } };
  }

  const { entry } = acquired;
  // acquireSession already reserved the busy flag for us.
  try {
    const result = await entry.sandbox.exec(command, {
      signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
    });
    return {
      status: 200,
      body: { ...result, cwd: entry.sandbox.getCwd() },
    };
  } catch (e) {
    return { status: 500, body: { error: (e as Error).message } };
  } finally {
    entry.busy = false;
    entry.lastUsed = Date.now();
  }
}

export function sessionCount(): number {
  return sessions.size;
}

/** Test helper. */
export function resetSessions(): void {
  sessions.clear();
}
