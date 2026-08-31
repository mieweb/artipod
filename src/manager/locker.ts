/**
 * Lock/login lifecycle (docs/encryption.md "The keyring and leases"):
 * "access expires" is the key evaporating from the keyring — never a data
 * rewrite. Client enforcement is cooperative (timer + visibilitychange +
 * explicit lock); the authority's hard power is refusing re-issue.
 */
import { importBlobKey } from '../oci/cipher.js';
import type { OciStore } from '../oci/store.js';
import type { Keyring } from './keyring.js';
import type { AuditLog } from './audit.js';
import type { LoginResult } from './authority.js';

export type LockMode = 'lock' | 'purge';

export interface PodLockerOptions {
  keyring: Keyring;
  /** podId → its store, for key binding and purge mode. */
  stores: Map<string, OciStore>;
  audit?: AuditLog;
  /** `lock` (default): ciphertext stays, login restores instantly.
   *  `purge` (kiosk): blobs deleted at lock; restore = re-sync. */
  mode?: LockMode;
  clock?: () => number;
}

export const kekName = (podId: string): string => `kek:${podId}`;

export class PodLocker {
  private readonly mode: LockMode;
  private readonly clock: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private detachVisibility: (() => void) | null = null;

  constructor(private readonly options: PodLockerOptions) {
    this.mode = options.mode ?? 'lock';
    this.clock = options.clock ?? Date.now;
  }

  /** Bind a store's encryption to the keyring: custody moves here. */
  async bind(podId: string): Promise<void> {
    const store = this.options.stores.get(podId);
    if (!store) throw new Error(`no store bound for pod '${podId}'`);
    await store.enableEncryption(() => this.options.keyring.getKey(kekName(podId)));
  }

  /** Accept a login result: KEKs into the keyring with the lease's expiry. */
  async adoptLogin(result: LoginResult): Promise<void> {
    const expiresAt = Date.parse(result.lease.expiresAt);
    for (const [podId, raw] of Object.entries(result.keys)) {
      this.options.keyring.put({
        name: kekName(podId),
        kind: 'kek',
        key: await importBlobKey(raw),
        expiresAt,
        meta: { principal: result.lease.principal, issuer: result.lease.issuer },
      });
    }
    await this.options.audit?.append({
      at: new Date(this.clock()).toISOString(),
      kind: 'login',
      principal: result.lease.principal,
      details: { podIds: result.lease.podIds.join(','), expiresAt: result.lease.expiresAt },
    });
    this.armExpiryTimer();
  }

  /** Drop keys now. Purge mode also deletes the blobs. */
  async lock(podId?: string): Promise<void> {
    // Audit first — after revocation an encrypted store can't take writes.
    await this.options.audit?.append({
      at: new Date(this.clock()).toISOString(),
      kind: 'lock',
      details: { scope: podId ?? 'all', mode: this.mode },
    });
    if (podId) this.options.keyring.revoke(kekName(podId));
    else this.options.keyring.revokeAll('kek:');
    if (this.mode === 'purge') {
      for (const [id, store] of this.options.stores) {
        if (!podId || id === podId) await store.purgeBlobs();
      }
    }
  }

  /** Lease expiries for `artipod status`. */
  status(): { name: string; expiresAt: number }[] {
    return this.options.keyring.list().filter((e) => e.kind === 'kek').map((e) => ({ name: e.name, expiresAt: e.expiresAt }));
  }

  /** Cooperative auto-lock: expiry timer + (browser) visibilitychange. */
  enableAutoLock(opts: { onVisibilityHidden?: boolean } = {}): () => void {
    this.armExpiryTimer();
    const unsubscribe = this.options.keyring.onChange(() => this.armExpiryTimer());
    if (opts.onVisibilityHidden && typeof document !== 'undefined') {
      const handler = () => {
        if (document.visibilityState === 'hidden') void this.lock();
      };
      document.addEventListener('visibilitychange', handler);
      this.detachVisibility = () => document.removeEventListener('visibilitychange', handler);
    }
    return () => {
      unsubscribe();
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.detachVisibility?.();
      this.detachVisibility = null;
    };
  }

  private armExpiryTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const next = this.options.keyring.nextExpiry();
    if (next === null) return;
    const delay = Math.max(0, next - this.clock()) + 1;
    this.timer = setTimeout(() => {
      this.options.keyring.evictExpired();
      this.armExpiryTimer();
    }, delay);
    // Node: don't hold the process open for a lock timer.
    (this.timer as { unref?: () => void }).unref?.();
  }
}
