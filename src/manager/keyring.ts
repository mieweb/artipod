/**
 * The session keyring (docs/encryption.md "The keyring and leases"):
 * unwrapped KEKs and minted capabilities with expiries — semantically Linux
 * `keyctl` with timeouts. Memory-only by design: persistence is what would
 * defeat the TTL. `/proc/keys` projects names + expiries, never material.
 */
import type { ProcProvider, ProcTree } from '../proc/registry.js';

/** Reads on a locked encrypted pod fail with this (POSIX-shaped). */
export class PodLockedError extends Error {
  readonly code = 'EACCES';
  constructor(detail: string) {
    super(`EACCES: pod locked — ${detail} (run \`artipod login\` to restore)`);
    this.name = 'PodLockedError';
  }
}

export interface KeyringEntryInfo {
  name: string;
  kind: 'kek' | 'capability';
  expiresAt: number;
  meta?: Record<string, string>;
}

interface KeyringEntry extends KeyringEntryInfo {
  key?: CryptoKey;
}

export class Keyring {
  private entries = new Map<string, KeyringEntry>();
  private changeListeners = new Set<() => void>();

  constructor(private readonly clock: () => number = Date.now) {}

  put(entry: KeyringEntry): void {
    this.entries.set(entry.name, entry);
    this.notify();
  }

  /** The KEK for `name`, or PodLockedError if absent/expired. */
  getKey(name: string): CryptoKey {
    const entry = this.live(name);
    if (!entry?.key) throw new PodLockedError(`no usable key '${name}' in this session`);
    return entry.key;
  }

  /** Live capability entry, or null. */
  getCapability(name: string): KeyringEntryInfo | null {
    const entry = this.live(name);
    return entry && entry.kind === 'capability' ? { ...entry, key: undefined } as KeyringEntryInfo : null;
  }

  has(name: string): boolean {
    return this.live(name) !== null;
  }

  revoke(name: string): boolean {
    const had = this.entries.delete(name);
    if (had) this.notify();
    return had;
  }

  /** Revoke everything, or every entry whose name starts with `prefix`. */
  revokeAll(prefix?: string): number {
    let n = 0;
    for (const name of [...this.entries.keys()]) {
      if (!prefix || name.startsWith(prefix)) {
        this.entries.delete(name);
        n++;
      }
    }
    if (n) this.notify();
    return n;
  }

  /** Names + expiries only — the /proc/keys contract. */
  list(): KeyringEntryInfo[] {
    this.evictExpired();
    return [...this.entries.values()]
      .map(({ key: _k, ...info }) => info)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  evictExpired(): number {
    const now = this.clock();
    let n = 0;
    for (const [name, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(name);
        n++;
      }
    }
    if (n) this.notify();
    return n;
  }

  /** Earliest expiry among live entries (for auto-lock timers), or null. */
  nextExpiry(): number | null {
    this.evictExpired();
    let min: number | null = null;
    for (const e of this.entries.values()) if (min === null || e.expiresAt < min) min = e.expiresAt;
    return min;
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private live(name: string): KeyringEntry | null {
    const entry = this.entries.get(name);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock()) {
      this.entries.delete(name);
      this.notify();
      return null;
    }
    return entry;
  }

  private notify(): void {
    for (const l of [...this.changeListeners]) l();
  }
}

/** `/proc/keys` — keyctl-style table + JSON twin. Never key material. */
export function makeKeysProcProvider(keyring: Keyring): ProcProvider {
  return {
    name: 'keys',
    description: 'session keyring: names + expiries (material never leaves the keyring)',
    mode: 'ro',
    async read(): Promise<ProcTree> {
      const entries = keyring.list();
      const table = entries
        .map((e) => `${e.kind.padEnd(10)} ${new Date(e.expiresAt).toISOString()} ${e.name}`)
        .join('\n');
      return {
        keys: `${'KIND'.padEnd(10)} ${'EXPIRES'.padEnd(24)} NAME\n${table}${table ? '\n' : ''}`,
        'keys.json': JSON.stringify(entries, null, 2),
      };
    },
  };
}
