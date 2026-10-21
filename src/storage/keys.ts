/**
 * KeysService — the client's key-lease machinery (spa-ui-plan U1, extracted
 * from the old app's lib/keys.ts with behavior parity):
 *
 *  - probe /api/keys once (failures NOT memoized — a later login re-probes)
 *  - ECDH device-wrapped login: the KEK crosses the wire wrapped to this
 *    device's non-extractable keypair; raw key bytes never exist in JS
 *  - the signed lease attaches to every same-origin /api/pods request via
 *    ONE fetch patch (covers HttpPodStore too — it derefs globalThis.fetch
 *    at call time); 401 → one re-login + retry unless explicitly released
 *  - renewal ~10s before expiry as the named task `keys:renew` (artipod ps)
 *  - the WRAPPED session persists (offline-grant exception, docs/encryption.md):
 *    a live lease survives reloads online and offline alike
 *  - forced-offline: /api requests reject like a dead network; pod setting is
 *    the source of truth, the mirror is the synchronous boot copy
 *
 * Framework-free (P10): environment specifics arrive via ServiceAdapters;
 * observable snapshots contain metadata only. Live keys stay in this service.
 */
import type { Lease, WireWrappedLoginResult } from '../manager/authority.js';
import type { ServiceAdapters } from './adapters.js';
import { TaskScheduler } from './task-scheduler.js';

/** Public broker metadata. Wrapped grants and live CryptoKeys are kept separately. */
export interface KeysMeta {
  authority: string;
  publicKey: string;
  podIds: string[];
  capTtlMs: number;
}

/** Serializable status for a host application's render surface. */
export interface BrokerSnapshot {
  /** none = no known broker; leased = live key; locked = known broker without a usable lease. */
  status: 'none' | 'leased' | 'locked';
  meta: KeysMeta | null;
  principal?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  renewing?: boolean;
  /** Epoch milliseconds of the last successful key issue or renewal. */
  lastRenewedAt?: number;
}

export interface SettingsSnapshot {
  forcedOffline: boolean;
}

/** A policy is known only after a successful broker probe or a definitive 404. */
export type KeyStoragePolicy = 'encrypted' | 'plaintext' | 'unknown';

/** Key custody needed by protected storage, independent of authentication UI. */
export interface StorageKeyProvider {
  getKey(): CryptoKey | null;
  requireKey(): CryptoKey;
  readonly storagePolicy: KeyStoragePolicy;
  readonly probeError?: string | null;
  /** Drain grant/device writes before erasure; release the retained flush key afterwards. */
  suspendForReset(): Promise<() => void>;
  setOfflineWriter?(writer: ((value: boolean) => Promise<void>) | null): void;
  flushOfflinePreference?(): Promise<void>;
  reconcileOffline?(value: boolean): void;
  /** Optional metadata observation for host lifecycle integrations. */
  getSnapshot?(): BrokerSnapshot;
  subscribe?(listener: () => void): () => void;
}

const LEASE_HEADER = 'x-artipod-lease';
const OFFLINE_KEY = 'artipod-forced-offline';
const META_KEY = 'artipod-broker-meta';
const RELEASED_KEY = 'artipod-lease-released';
export const RENEW_TASK = 'keys:renew';

export class KeysService implements StorageKeyProvider {
  private state: BrokerSnapshot = { status: 'none', meta: null };
  private settings: SettingsSnapshot;
  private readonly listeners = new Set<() => void>();
  private leaseB64: string | null = null;
  /** The live signed lease + device-unwrapped KEKs (non-extractable), memory only. */
  private currentLease: Lease | null = null;
  private podKeys: Record<string, CryptoKey> = {};
  private probePromise: Promise<KeysMeta | null> | null = null;
  private policy: KeyStoragePolicy = 'unknown';
  private lastProbeError: string | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private leaseGeneration = 0;
  private storageSuspended = false;
  private readonly storageOperations = new Set<Promise<unknown>>();
  /** Authentication challenges contain no usable key material and may survive lock. */
  private readonly keyChecks = new Map<string, { iv: ArrayBuffer; ciphertext: ArrayBuffer }>();
  private installed = false;
  /** Explicit lease release — suppresses the 401 auto-relogin until the next login. */
  private released = false;
  private principal: (() => Promise<string>) | null = null;
  /** U3 wires the pod-settings write-through here (fs exists only after boot). */
  private offlineWriter: ((value: boolean) => Promise<void>) | null = null;
  /** An explicit toggle wins over stored settings until its write succeeds. */
  private pendingOffline: { value: boolean } | null = null;
  private offlineWrites: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapters: ServiceAdapters,
    readonly scheduler: TaskScheduler = new TaskScheduler(adapters.now),
  ) {
    this.released = adapters.mirror.get(RELEASED_KEY) === '1';
    this.settings = { forcedOffline: adapters.mirror.get(OFFLINE_KEY) === '1' };
    scheduler.register(RENEW_TASK, async () => {
      if (this.principal) await this.login(await this.principal());
    });
  }

  // ── snapshots ────────────────────────────────────────────────────────────

  /** Stable until the next broker update; contains no lease document or key material. */
  getSnapshot = (): BrokerSnapshot => this.state;

  /** Stable until the next offline preference update. */
  getSettingsSnapshot = (): SettingsSnapshot => this.settings;

  /** Subscribe to broker or offline preference changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private setState(next: BrokerSnapshot): void {
    this.state = next;
    this.notify();
  }

  private setSettings(next: SettingsSnapshot): void {
    this.settings = next;
    this.notify();
  }

  get forcedOffline(): boolean {
    return this.settings.forcedOffline;
  }

  /** Only a successful broker probe or a definitive 404 establishes policy. */
  get storagePolicy(): KeyStoragePolicy {
    return this.policy;
  }

  get probeError(): string | null {
    return this.lastProbeError;
  }

  private async stored<T>(operation: () => Promise<T>): Promise<T> {
    if (this.storageSuspended) throw new Error('Key storage is suspended for browser reset; reload to resume');
    const pending = operation();
    this.storageOperations.add(pending);
    try { return await pending; }
    finally { this.storageOperations.delete(pending); }
  }

  private persist(key: string, value: unknown): Promise<void> {
    return this.stored(() => this.adapters.kv.put(key, value));
  }

  /** Drain device/grant IO before erasure, retaining the lease only for flush. */
  async suspendForReset(): Promise<() => void> {
    this.storageSuspended = true;
    this.leaseGeneration += 1;
    this.scheduler.cancel(RENEW_TASK);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    while (this.storageOperations.size) await Promise.allSettled([...this.storageOperations]);
    return () => this.dropLease();
  }

  // ── keys (never in a store) ──────────────────────────────────────────────

  /** The live lease document (for adopting into a pod's keyring), or null. */
  getLease(): Lease | null {
    return this.hasLiveLease() ? this.currentLease : null;
  }

  /** The broker KEK for the served store (non-extractable), or null when locked. */
  getKey(): CryptoKey | null {
    if (!this.hasLiveLease()) return null;
    const first = this.state.meta?.podIds[0];
    return (first && this.podKeys[first]) || Object.values(this.podKeys)[0] || null;
  }

  /** getKey that throws — the shape encrypted mounts want. */
  requireKey = (): CryptoKey => {
    const key = this.getKey();
    if (!key) throw new Error('EACCES: pod locked — no live broker lease in this tab (login to restore)');
    return key;
  };

  private hasLiveLease(): boolean {
    if (!this.currentLease || this.state.status !== 'leased') return false;
    const expiresAt = Date.parse(this.currentLease.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.adapters.now()) {
      this.dropLease();
      return false;
    }
    return true;
  }

  private dropLease(): void {
    this.leaseGeneration += 1;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.scheduler.cancel(RENEW_TASK);
    this.leaseB64 = null;
    this.currentLease = null;
    this.podKeys = {};
    void this.persist('session', undefined).catch(() => {});
    this.setState({ status: 'locked', meta: this.state.meta, lastRenewedAt: this.state.lastRenewedAt });
  }

  /** Expiry is independent of renewal: offline tabs must lock on time too. */
  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (!this.currentLease) return;
    const remaining = Date.parse(this.currentLease.expiresAt) - this.adapters.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.dropLease();
      return;
    }
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      if (this.hasLiveLease()) this.armExpiry();
    }, Math.min(remaining, 2_147_483_647));
    // Node service consumers need not keep their process alive for a lease.
    (this.expiryTimer as unknown as { unref?: () => void }).unref?.();
  }

  // ── forced offline ───────────────────────────────────────────────────────

  /** U3: route offline writes into the pod setting once the fs exists. */
  setOfflineWriter(writer: ((value: boolean) => Promise<void>) | null): void {
    this.offlineWriter = writer;
  }

  setForcedOffline(value: boolean): void {
    this.adapters.mirror.set(OFFLINE_KEY, value ? '1' : null);
    this.setSettings({ forcedOffline: value });
    this.pendingOffline = { value };
    void this.flushOfflinePreference().catch(() => {});
  }

  /** Retry after the root adopts an unlocked key, before reading saved settings. */
  flushOfflinePreference(): Promise<void> {
    const writing = this.offlineWrites.catch(() => {}).then(async () => {
      while (this.pendingOffline && this.offlineWriter && !this.storageSuspended) {
        const pending = this.pendingOffline;
        await this.offlineWriter(pending.value);
        if (this.pendingOffline === pending) this.pendingOffline = null;
      }
    });
    this.offlineWrites = writing;
    return writing;
  }

  /** Adopt an externally-changed pod setting (shells write it; U3 calls this on fs:changed). */
  reconcileOffline(value: boolean): void {
    if (this.pendingOffline) return;
    this.adapters.mirror.set(OFFLINE_KEY, value ? '1' : null);
    if (value !== this.forcedOffline) this.setSettings({ forcedOffline: value });
  }

  // ── lease lifecycle ──────────────────────────────────────────────────────

  /**
   * Drop the lease + keys NOW (≈ `artipod lock`): locked badge, encrypted
   * reads fail, no auto-relogin until the next explicit login. Ciphertext at
   * rest is untouched — login restores. Drops the persisted grant too.
   */
  release(): void {
    // IndexedDB deletion is asynchronous. A synchronous opaque tombstone
    // prevents an immediate reload from restoring the grant being removed.
    this.adapters.mirror.set(RELEASED_KEY, '1');
    this.released = true;
    if (this.state.status !== 'none' || this.policy === 'encrypted') this.dropLease();
  }

  private async probe(): Promise<KeysMeta | null> {
    const pending = this.probePromise ??= (async () => {
      try {
        const res = await this.rawFetch('/api/keys');
        if (res.status === 404) {
          this.policy = 'plaintext';
          this.lastProbeError = null;
          return null;
        }
        if (!res.ok) throw new Error(`Key broker unavailable (HTTP ${res.status})`);
        const meta = (await res.json()) as KeysMeta;
        if (
          typeof meta.authority !== 'string' || typeof meta.publicKey !== 'string' ||
          !Array.isArray(meta.podIds) || !meta.podIds.every((id) => typeof id === 'string') ||
          !Number.isFinite(meta.capTtlMs) || meta.capTtlMs <= 0
        ) throw new Error('Key broker returned invalid metadata');
        this.policy = 'encrypted';
        this.lastProbeError = null;
        this.adapters.mirror.set(META_KEY, JSON.stringify(meta));
        return meta;
      } catch (error) {
        // transient (offline): DON'T cache — a later login must re-probe
        this.lastProbeError = error instanceof Error ? error.message : 'Key broker unavailable';
        return null;
      }
    })();
    const meta = await pending;
    if (this.lastProbeError && this.probePromise === pending) this.probePromise = null;
    return meta;
  }

  /** Last-known broker metadata — lets an offline reload show 'locked' instead of nothing. */
  private cachedMeta(): KeysMeta | null {
    const raw = this.adapters.mirror.get(META_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as KeysMeta;
    } catch {
      return null;
    }
  }

  /** This device's ECDH keypair (non-extractable, structured-cloned into kv). */
  private async deviceKeyPair(): Promise<{ privateKey: CryptoKey; publicKeyB64: string }> {
    const read = await this.stored(() => this.adapters.kv.get<{ privateKey: CryptoKey; publicKeyB64: string }>('keypair'));
    if (read) return read;
    const { generateDeviceKeyPair } = await import('../manager/crypto.js');
    const pair = await generateDeviceKeyPair();
    const record = { privateKey: pair.privateKey, publicKeyB64: pair.publicKeyB64 };
    await this.persist('keypair', record);
    return record;
  }

  private async validateKeys(candidate: Record<string, CryptoKey>): Promise<Record<string, CryptoKey>> {
    const keys: Record<string, CryptoKey> = {};
    for (const [podId, key] of Object.entries(candidate)) {
      const proof = this.keyChecks.get(podId);
      if (proof) {
        try {
          await crypto.subtle.decrypt({ name: 'AES-GCM', iv: proof.iv }, key, proof.ciphertext);
        } catch {
          this.lastProbeError = 'The broker encryption key changed. Browser storage remains locked; restore the original key before retrying.';
          this.dropLease();
          throw new Error(this.lastProbeError);
        }
      } else {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const challenge = crypto.getRandomValues(new Uint8Array(32));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, challenge);
        this.keyChecks.set(podId, { iv: iv.buffer, ciphertext });
      }
      // Normal renewal imports an equivalent key. Preserve the live object
      // so the vault need not interrupt every operation just to repin it.
      keys[podId] = this.hasLiveLease() && this.podKeys[podId] ? this.podKeys[podId] : key;
    }
    return keys;
  }

  private adopt(lease: Lease, cryptoKeys: Record<string, CryptoKey>, meta: KeysMeta | null, fresh: boolean): void {
    if (!Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= this.adapters.now()) {
      throw new Error('Key broker returned an expired lease');
    }
    this.policy = 'encrypted';
    this.currentLease = lease;
    this.podKeys = cryptoKeys;
    this.leaseB64 = btoa(JSON.stringify(lease));
    this.setState({
      status: 'leased',
      meta: meta ?? this.state.meta ?? this.cachedMeta(),
      principal: lease.principal,
      expiresAt: Date.parse(lease.expiresAt),
      lastRenewedAt: fresh ? this.adapters.now() : this.state.lastRenewedAt,
    });
    this.armRenewal();
    this.armExpiry();
  }

  /**
   * The persisted session is the OFFLINE-GRANT exception (docs/encryption.md):
   * lease + device-WRAPPED keys, bounded by the lease's validity. Raw keys
   * never persist.
   */
  private async restoreSession(): Promise<boolean> {
    if (this.released || this.adapters.mirror.get(RELEASED_KEY) === '1') return false;
    const generation = this.leaseGeneration;
    try {
      const wire = await this.stored(() => this.adapters.kv.get<WireWrappedLoginResult>('session'));
      if (!wire) return false;
      if (!Number.isFinite(Date.parse(wire.lease.expiresAt)) || Date.parse(wire.lease.expiresAt) <= this.adapters.now()) {
        await this.persist('session', undefined);
        return false;
      }
      const device = await this.deviceKeyPair();
      const { unwrapLoginResult } = await import('../manager/authority.js');
      const { lease, cryptoKeys } = await unwrapLoginResult(wire, device.privateKey);
      const validated = await this.validateKeys(cryptoKeys);
      if (generation !== this.leaseGeneration || this.released) return false;
      this.adopt(lease, validated, null, false);
      return true;
    } catch {
      return false;
    }
  }

  /** Login uses an opaque profile identity and must never depend on the locked filesystem. */
  async login(principal: string): Promise<boolean> {
    if (this.storageSuspended) return false;
    // A background tab may not have run its expiry timer yet. Revoke the old
    // grant before capturing this fresh login's cancellation generation.
    this.hasLiveLease();
    const generation = ++this.leaseGeneration;
    this.released = false;
    const meta = await this.probe();
    if (!meta || generation !== this.leaseGeneration || this.released) return false;
    this.setState({ ...this.state, meta, renewing: true });
    try {
      const device = await this.deviceKeyPair();
      const res = await this.rawFetch('/api/keys/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ principal, devicePublicKey: device.publicKeyB64 }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const wire = (await res.json()) as WireWrappedLoginResult;
      const { unwrapLoginResult } = await import('../manager/authority.js');
      const { lease, cryptoKeys } = await unwrapLoginResult(wire, device.privateKey);
      const validated = await this.validateKeys(cryptoKeys);
      if (generation !== this.leaseGeneration || this.released) return false;
      await this.persist('session', wire).catch(() => {}); // wrapped ciphertext only
      if (generation !== this.leaseGeneration || this.released) return false;
      this.adapters.mirror.set(RELEASED_KEY, null);
      this.adopt(lease, validated, meta, true);
      return true;
    } catch {
      if (generation !== this.leaseGeneration || this.released) return false;
      // A failed renewal does not revoke a still-valid offline grant.
      if (this.hasLiveLease()) {
        this.setState({ ...this.state, renewing: false });
        return false;
      }
      // token-gated broker (or offline): locked badge; retry via the badge
      this.dropLease();
      return false;
    }
  }

  /** Re-login ~10s before expiry via the scheduler (visible in `artipod ps`). */
  private armRenewal(): void {
    const expiresAt = this.state.expiresAt;
    if (!expiresAt) return;
    this.scheduler.schedule(RENEW_TASK, Math.max(1_000, expiresAt - this.adapters.now() - 10_000));
  }

  // ── the fetch patch ──────────────────────────────────────────────────────

  private isPodsUrl(input: RequestInfo | URL): boolean {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith('/api/pods') || (!!this.adapters.origin && url.startsWith(`${this.adapters.origin}/api/pods`));
  }

  private isApiUrl(input: RequestInfo | URL): boolean {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith('/api/') || (!!this.adapters.origin && url.startsWith(`${this.adapters.origin}/api/`));
  }

  /** The bare fetch minus the lease patch — the offline toggle still blocks it
   * (or probe/login would sneak past the "dead network"). */
  private rawFetch: typeof fetch = (...args) => {
    if (this.storageSuspended) return Promise.reject(new Error('Key storage is suspended for browser reset'));
    if (this.forcedOffline && this.isApiUrl(args[0] as RequestInfo | URL)) {
      return Promise.reject(new TypeError('Failed to fetch — forced offline (demo toggle)'));
    }
    return this.adapters.fetch(...args);
  };

  /** The patched fetch — exposed for tests; `install()` makes it globalThis.fetch. */
  patchedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.forcedOffline && this.isApiUrl(input)) {
      throw new TypeError('Failed to fetch — forced offline (demo toggle)');
    }
    if (!this.isPodsUrl(input)) return this.adapters.fetch(input, init);
    const attempt = (): Promise<Response> => {
      this.hasLiveLease(); // an expired header must never escape a throttled background tab
      // node's Request cannot take a relative URL (browsers resolve against
      // the page) — resolve against the adapter origin for parity.
      const resolved =
        typeof input === 'string' && input.startsWith('/')
          ? `${this.adapters.origin || 'http://localhost'}${input}`
          : (input as string | URL);
      const req = new Request(resolved, init);
      if (this.leaseB64) req.headers.set(LEASE_HEADER, this.leaseB64);
      return this.adapters.fetch(req);
    };
    let res = await attempt();
    if (res.status === 401 && !this.released && this.principal && (await this.login(await this.principal()))) {
      res = await attempt();
    }
    return res;
  };

  /**
   * Probe the serve and, when it brokers keys, login and patch globalThis.fetch.
   * The patch installs on EVERY serve (it carries the offline toggle); on
   * plaintext serves it is a passthrough. Idempotent.
   */
  async install(principal: () => Promise<string>): Promise<BrokerSnapshot> {
    if (this.storageSuspended) throw new Error('Key storage is suspended for browser reset; reload to resume');
    this.principal = principal;
    if (!this.installed) {
      this.installed = true;
      globalThis.fetch = this.patchedFetch as typeof fetch;
    }
    // A still-valid device-wrapped session survives reloads — ONLINE AND
    // OFFLINE alike. Falls through to a fresh login when absent/expired.
    if (!this.hasLiveLease() && !this.released) await this.restoreSession();
    const meta = await this.probe();
    if (!meta) {
      // unreachable serve: a restored lease stays leased; a previously-seen
      // broker without one shows LOCKED; an unknown serve shows nothing
      const known = this.cachedMeta();
      if (known && this.policy !== 'plaintext') {
        this.policy = 'encrypted';
        if (this.state.status === 'none') this.setState({ status: 'locked', meta: known });
      }
      return this.state;
    }
    if (!this.hasLiveLease()) {
      if (this.released) {
        // A reload creates a fresh snapshot even though the persisted release
        // marker suppresses login. Keep the explicit unlock action available.
        this.setState({ status: 'locked', meta, lastRenewedAt: this.state.lastRenewedAt });
      } else await this.login(await principal());
    }
    return this.state;
  }
}
