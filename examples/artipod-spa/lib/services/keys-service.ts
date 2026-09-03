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
 * DOM-free (P10): browser specifics arrive via ServiceAdapters; state goes
 * out as snapshots to brokerStore/settingsStore. Keys NEVER enter a store.
 */
import type { Lease, WireWrappedLoginResult } from '@artipod/core/manager';
import type { ServiceAdapters } from './adapters';
import { TaskScheduler } from './task-scheduler';
import { brokerStore, type BrokerSnapshot, type KeysMeta } from '../stores/broker';
import { settingsStore } from '../stores/settings';

const LEASE_HEADER = 'x-artipod-lease';
const OFFLINE_KEY = 'artipod-forced-offline';
const META_KEY = 'artipod-broker-meta';
export const RENEW_TASK = 'keys:renew';

export class KeysService {
  private leaseB64: string | null = null;
  /** The live signed lease + device-unwrapped KEKs (non-extractable), memory only. */
  private currentLease: Lease | null = null;
  private podKeys: Record<string, CryptoKey> = {};
  private probePromise: Promise<KeysMeta | null> | null = null;
  private installed = false;
  /** Explicit lease release — suppresses the 401 auto-relogin until the next login. */
  private released = false;
  private principal: (() => Promise<string>) | null = null;
  /** U3 wires the pod-settings write-through here (fs exists only after boot). */
  private offlineWriter: ((value: boolean) => Promise<void>) | null = null;

  constructor(
    private readonly adapters: ServiceAdapters,
    readonly scheduler: TaskScheduler = new TaskScheduler(adapters.now),
  ) {
    settingsStore.setState({ forcedOffline: adapters.mirror.get(OFFLINE_KEY) === '1' });
    scheduler.register(RENEW_TASK, async () => {
      if (this.principal) await this.login(await this.principal());
    });
  }

  // ── snapshots ────────────────────────────────────────────────────────────

  private get state(): BrokerSnapshot {
    return brokerStore.getState();
  }

  private setState(next: BrokerSnapshot): void {
    brokerStore.setState(next, true);
  }

  get forcedOffline(): boolean {
    return settingsStore.getState().forcedOffline;
  }

  // ── keys (never in a store) ──────────────────────────────────────────────

  /** The live lease document (for adopting into a pod's keyring), or null. */
  getLease(): Lease | null {
    return this.currentLease && this.state.status === 'leased' ? this.currentLease : null;
  }

  /** The broker KEK for the served store (non-extractable), or null when locked. */
  getKey(): CryptoKey | null {
    if (this.state.status !== 'leased') return null;
    const first = this.state.meta?.podIds[0];
    return (first && this.podKeys[first]) || Object.values(this.podKeys)[0] || null;
  }

  /** getKey that throws — the shape encrypted mounts want. */
  requireKey = (): CryptoKey => {
    const key = this.getKey();
    if (!key) throw new Error('EACCES: pod locked — no live broker lease in this tab (login to restore)');
    return key;
  };

  // ── forced offline ───────────────────────────────────────────────────────

  /** U3: route offline writes into the pod setting once the fs exists. */
  setOfflineWriter(writer: ((value: boolean) => Promise<void>) | null): void {
    this.offlineWriter = writer;
  }

  setForcedOffline(value: boolean): void {
    this.adapters.mirror.set(OFFLINE_KEY, value ? '1' : null);
    settingsStore.setState({ forcedOffline: value });
    void this.offlineWriter?.(value).catch(() => {});
  }

  /** Adopt an externally-changed pod setting (shells write it; U3 calls this on fs:changed). */
  reconcileOffline(value: boolean): void {
    this.adapters.mirror.set(OFFLINE_KEY, value ? '1' : null);
    if (value !== this.forcedOffline) settingsStore.setState({ forcedOffline: value });
  }

  // ── lease lifecycle ──────────────────────────────────────────────────────

  /**
   * Drop the lease + keys NOW (≈ `artipod lock`): locked badge, encrypted
   * reads fail, no auto-relogin until the next explicit login. Ciphertext at
   * rest is untouched — login restores. Drops the persisted grant too.
   */
  release(): void {
    this.released = true;
    this.scheduler.cancel(RENEW_TASK);
    this.leaseB64 = null;
    this.currentLease = null;
    this.podKeys = {};
    void this.adapters.kv.put('session', undefined).catch(() => {});
    if (this.state.status !== 'none') {
      this.setState({ status: 'locked', meta: this.state.meta, lastRenewedAt: this.state.lastRenewedAt });
    }
  }

  private async probe(): Promise<KeysMeta | null> {
    this.probePromise ??= (async () => {
      try {
        const res = await this.rawFetch('/api/keys');
        if (!res.ok) return null; // definitive: not a broker serve
        const meta = (await res.json()) as KeysMeta;
        this.adapters.mirror.set(META_KEY, JSON.stringify(meta));
        return meta;
      } catch {
        // transient (offline): DON'T cache — a later login must re-probe
        this.probePromise = null;
        return null;
      }
    })();
    return this.probePromise;
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
    const read = await this.adapters.kv.get<{ privateKey: CryptoKey; publicKeyB64: string }>('keypair');
    if (read) return read;
    const { generateDeviceKeyPair } = await import('@artipod/core/manager');
    const pair = await generateDeviceKeyPair();
    const record = { privateKey: pair.privateKey, publicKeyB64: pair.publicKeyB64 };
    await this.adapters.kv.put('keypair', record);
    return record;
  }

  private adopt(wire: WireWrappedLoginResult, lease: Lease, cryptoKeys: Record<string, CryptoKey>, meta: KeysMeta | null, fresh: boolean): void {
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
  }

  /**
   * The persisted session is the OFFLINE-GRANT exception (docs/encryption.md):
   * lease + device-WRAPPED keys, bounded by the lease's validity. Raw keys
   * never persist.
   */
  private async restoreSession(): Promise<boolean> {
    try {
      const wire = await this.adapters.kv.get<WireWrappedLoginResult>('session');
      if (!wire) return false;
      if (Date.parse(wire.lease.expiresAt) <= this.adapters.now() + 5_000) {
        await this.adapters.kv.put('session', undefined);
        return false;
      }
      const device = await this.deviceKeyPair();
      const { unwrapLoginResult } = await import('@artipod/core/manager');
      const { lease, cryptoKeys } = await unwrapLoginResult(wire, device.privateKey);
      this.adopt(wire, lease, cryptoKeys, null, false);
      return true;
    } catch {
      return false;
    }
  }

  /** Login against the broker; principal is the catalog's LWW actor id. */
  async login(principal: string): Promise<boolean> {
    const meta = await this.probe();
    if (!meta) return false;
    this.released = false; // an explicit or auto login re-arms the session
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
      const { unwrapLoginResult } = await import('@artipod/core/manager');
      const { lease, cryptoKeys } = await unwrapLoginResult(wire, device.privateKey);
      await this.adapters.kv.put('session', wire).catch(() => {}); // wrapped ciphertext only
      this.adopt(wire, lease, cryptoKeys, meta, true);
      return true;
    } catch {
      // token-gated broker (or offline): locked badge; retry via the badge
      this.leaseB64 = null;
      this.currentLease = null;
      this.podKeys = {};
      this.setState({ status: 'locked', meta, lastRenewedAt: this.state.lastRenewedAt });
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
    this.principal = principal;
    if (!this.installed) {
      this.installed = true;
      globalThis.fetch = this.patchedFetch as typeof fetch;
    }
    // A still-valid device-wrapped session survives reloads — ONLINE AND
    // OFFLINE alike. Falls through to a fresh login when absent/expired.
    if (this.state.status !== 'leased') await this.restoreSession();
    const meta = await this.probe();
    if (!meta) {
      // unreachable serve: a restored lease stays leased; a previously-seen
      // broker without one shows LOCKED; an unknown serve shows nothing
      const known = this.cachedMeta();
      if (known && this.state.status === 'none') this.setState({ status: 'locked', meta: known });
      return this.state;
    }
    if (this.state.status !== 'leased') await this.login(await principal());
    return this.state;
  }
}
