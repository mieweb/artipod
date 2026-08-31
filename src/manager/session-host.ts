/**
 * PodSessionHost — the generic pod/session hosting graduated from
 * artipod-sync's exec-sessions (plan Phase 6, Decision #2): per-session
 * chroot views over one shared ZenFS store, TTL eviction, in-flight guard,
 * hardened limits. HTTP wiring, auth, and the policy NUMBERS stay in the
 * app — they arrive here as options.
 */

import { createSandbox } from '../sandbox/index.js';
import type { Sandbox, ZenFsLike } from '../sandbox/types.js';

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface SessionHostOptions {
  ttlMs: number;
  maxSessions: number;
  execTimeoutMs: number;
  maxFsBytes: number;
  /** Root prefix for per-session chroots. Default: /sessions */
  rootPrefix?: string;
}

interface SessionEntry {
  sandbox: Sandbox;
  lastUsed: number;
  busy: boolean;
}

export type SessionAcquire =
  | { ok: true; sandbox: Sandbox; release: () => void }
  | { ok: false; status: number; message: string };

export class PodSessionHost {
  private sessions = new Map<string, SessionEntry>();
  private fsReady: Promise<void> | null = null;

  constructor(private readonly options: SessionHostOptions) {}

  private async ensureGlobalFs(): Promise<void> {
    if (!this.fsReady) {
      this.fsReady = (async () => {
        const { configure, InMemory } = await import('@zenfs/core');
        try {
          await configure({ mounts: { '/': InMemory } });
        } catch (e) {
          if (!(e instanceof Error) || !e.message.includes('Mount point is already in use')) throw e;
        }
      })();
    }
    return this.fsReady;
  }

  evictExpired(now = Date.now()): void {
    this.sessions.forEach((entry, id) => {
      if (now - entry.lastUsed > this.options.ttlMs) this.sessions.delete(id);
    });
  }

  get size(): number {
    return this.sessions.size;
  }

  async acquire(sessionId: string): Promise<SessionAcquire> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return { ok: false, status: 400, message: 'invalid session id' };
    }
    await this.ensureGlobalFs();
    this.evictExpired();

    let entry = this.sessions.get(sessionId);
    if (!entry) {
      if (this.sessions.size >= this.options.maxSessions) {
        return { ok: false, status: 503, message: 'session limit reached, try again later' };
      }
      const core = await import('@zenfs/core');
      const root = `${this.options.rootPrefix ?? '/sessions'}/${sessionId}`;
      await core.fs.promises.mkdir(`${root}/repo`, { recursive: true });
      const existing = this.sessions.get(sessionId);
      if (existing) {
        entry = existing;
      } else {
        const ctx = core.bindContext({ root });
        entry = {
          sandbox: createSandbox({
            zfs: ctx.fs as unknown as ZenFsLike,
            executionLimitProfile: 'hardened',
            executionLimits: { maxFileSystemBytes: this.options.maxFsBytes },
          }),
          lastUsed: Date.now(),
          busy: false,
        };
        this.sessions.set(sessionId, entry);
      }
    }

    if (entry.busy) {
      return { ok: false, status: 429, message: 'a command is already running in this session' };
    }
    entry.busy = true;
    entry.lastUsed = Date.now();
    const finalEntry = entry;
    return {
      ok: true,
      sandbox: entry.sandbox,
      release: () => {
        finalEntry.busy = false;
        finalEntry.lastUsed = Date.now();
      },
    };
  }

  /** Run one command with the host's timeout; releases the session after. */
  async exec(sessionId: string, command: string): Promise<
    | { ok: true; stdout: string; stderr: string; exitCode: number }
    | { ok: false; status: number; message: string }
  > {
    const acquired = await this.acquire(sessionId);
    if (!acquired.ok) return acquired;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.execTimeoutMs);
    try {
      const result = await acquired.sandbox.exec(command, { signal: controller.signal });
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, status: 500, message: (e as Error).message };
    } finally {
      clearTimeout(timer);
      acquired.release();
    }
  }
}
