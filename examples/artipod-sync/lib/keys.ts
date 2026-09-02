/**
 * Client for a broker serve's /api/keys surface (serve plan S5.5, V9/V10):
 * probe once, auto-login with a DEVICE-WRAPPED key exchange (ECDH — the KEK
 * crosses the wire wrapped to this device's non-extractable keypair and
 * unwraps to a non-extractable AES key: raw key bytes never exist in
 * page-visible JS), keep the signed lease IN MEMORY ONLY, attach it to
 * every same-origin /api/pods request, retry once on 401, and re-login
 * shortly before expiry.
 *
 * One fetch patch covers the whole app — the scattered raw fetch('/api/pods…')
 * calls AND HttpPodStore (it dereferences globalThis.fetch at call time).
 */
import type { Lease, WireWrappedLoginResult } from '@artipod/core/manager';

export interface KeysMeta {
  authority: string;
  publicKey: string;
  podIds: string[];
  capTtlMs: number;
}

export interface BrokerState {
  /** none = not a broker serve; leased = live key; locked = broker present but no usable lease. */
  status: 'none' | 'leased' | 'locked';
  meta: KeysMeta | null;
  principal?: string;
  /** epoch ms */
  expiresAt?: number;
  /** A re-key (lease renewal) is in flight right now. */
  renewing?: boolean;
  /** epoch ms of the last successful key issue/renewal. */
  lastRenewedAt?: number;
}

const LEASE_HEADER = 'x-artipod-lease';
const OFFLINE_KEY = 'artipod-forced-offline';
const META_KEY = 'artipod-broker-meta';

const readPersisted = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // SSR/prerender or storage blocked
  }
};
const writePersisted = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // best effort
  }
};

let state: BrokerState = { status: 'none', meta: null };
let leaseB64: string | null = null;
/** The live signed lease + device-unwrapped KEKs (non-extractable), memory only. */
let currentLease: Lease | null = null;
let podKeys: Record<string, CryptoKey> = {};
let renewTimer: ReturnType<typeof setTimeout> | null = null;
let probePromise: Promise<KeysMeta | null> | null = null;
let installed = false;
/** Demo toggle: reject every same-origin /api request like a dead network. Survives reloads. */
let forcedOffline = readPersisted(OFFLINE_KEY) === '1';
/** Explicit lease release — suppresses the 401 auto-relogin until the user logs in again. */
let released = false;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

export function getBrokerState(): BrokerState {
  return state;
}

export function isForcedOffline(): boolean {
  return forcedOffline;
}

/** Flip the demo's forced-offline mode: /api requests fail like a dead network. */
export function setForcedOffline(value: boolean): void {
  forcedOffline = value;
  writePersisted(OFFLINE_KEY, value ? '1' : null);
  notify();
}

/**
 * Drop the lease + keys from this tab NOW (≈ `artipod lock`): the badge goes
 * locked, encrypted reads start failing, and nothing auto-relogins until the
 * user clicks login. Ciphertext at rest is untouched — login restores.
 */
export function releaseLease(): void {
  released = true;
  if (renewTimer) clearTimeout(renewTimer);
  renewTimer = null;
  leaseB64 = null;
  currentLease = null;
  podKeys = {};
  if (state.status !== 'none') state = { status: 'locked', meta: state.meta, lastRenewedAt: state.lastRenewedAt };
  notify();
}

/** The live lease document (for adopting into a pod's keyring), or null. */
export function getBrokerLease(): Lease | null {
  return currentLease && state.status === 'leased' ? currentLease : null;
}

/** The broker KEK for the served store (non-extractable), or null when locked. */
export function getBrokerKey(): CryptoKey | null {
  if (state.status !== 'leased') return null;
  const first = state.meta?.podIds[0];
  return (first && podKeys[first]) || Object.values(podKeys)[0] || null;
}

/** getBrokerKey that throws — the shape EncryptedFS getKey wants. */
export function requireBrokerKey(): CryptoKey {
  const key = getBrokerKey();
  if (!key) throw new Error('EACCES: pod locked — no live broker lease in this tab (login to restore)');
  return key;
}

export function onBrokerChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The bare fetch, untouched by the lease patch — but the offline toggle
 * blocks it too, or probe/login would sneak past the "dead network". */
const rawFetch: typeof fetch = (...args) => {
  if (forcedOffline && isApiUrl(args[0] as RequestInfo | URL)) {
    return Promise.reject(new TypeError('Failed to fetch — forced offline (demo toggle)'));
  }
  return bareFetch(...args);
};
let bareFetch: typeof fetch = (...args) => globalThis.fetch(...args);

async function probe(): Promise<KeysMeta | null> {
  probePromise ??= (async () => {
    try {
      const res = await rawFetch('/api/keys');
      if (!res.ok) return null; // definitive: not a broker serve
      const meta = (await res.json()) as KeysMeta;
      writePersisted(META_KEY, JSON.stringify(meta));
      return meta;
    } catch {
      // transient (offline): DON'T cache — a later login must re-probe
      probePromise = null;
      return null;
    }
  })();
  return probePromise;
}

/** Last-known broker metadata — lets an offline reload show 'locked' instead of nothing. */
function cachedMeta(): KeysMeta | null {
  const raw = readPersisted(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as KeysMeta;
  } catch {
    return null;
  }
}

/** This tab's ECDH device keypair (non-extractable, structured-cloned into IndexedDB). */
async function deviceKeyPair(): Promise<{ privateKey: CryptoKey; publicKeyB64: string }> {
  const DB = 'artipod-keys';
  const STORE = 'device';
  const db = await new Promise<IDBDatabase>((resolveDb, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolveDb(req.result);
    req.onerror = () => reject(req.error);
  });
  const read = await new Promise<{ privateKey: CryptoKey; publicKeyB64: string } | undefined>((resolveGet, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get('keypair');
    req.onsuccess = () => resolveGet(req.result as { privateKey: CryptoKey; publicKeyB64: string } | undefined);
    req.onerror = () => reject(req.error);
  });
  if (read) {
    db.close();
    return read;
  }
  const { generateDeviceKeyPair } = await import('@artipod/core/manager');
  const pair = await generateDeviceKeyPair();
  const record = { privateKey: pair.privateKey, publicKeyB64: pair.publicKeyB64 };
  await new Promise<void>((resolvePut, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record, 'keypair');
    tx.oncomplete = () => resolvePut();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return record;
}

/** Login against the broker; principal is the catalog's LWW actor id. */
export async function brokerLogin(principal: string): Promise<boolean> {
  const meta = await probe();
  if (!meta) return false;
  released = false; // an explicit or auto login re-arms the session
  state = { ...state, meta, renewing: true };
  notify();
  try {
    const device = await deviceKeyPair();
    const res = await rawFetch('/api/keys/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principal, devicePublicKey: device.publicKeyB64 }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const wire = (await res.json()) as WireWrappedLoginResult;
    const { unwrapLoginResult } = await import('@artipod/core/manager');
    const { lease, cryptoKeys } = await unwrapLoginResult(wire, device.privateKey);
    currentLease = lease;
    podKeys = cryptoKeys;
    leaseB64 = btoa(JSON.stringify(lease));
    state = {
      status: 'leased',
      meta,
      principal: lease.principal,
      expiresAt: Date.parse(lease.expiresAt),
      lastRenewedAt: Date.now(),
    };
    armRenewal(principal);
    notify();
    return true;
  } catch {
    // token-gated broker (or offline): the badge shows locked; retry via the badge
    leaseB64 = null;
    currentLease = null;
    podKeys = {};
    state = { status: 'locked', meta, lastRenewedAt: state.lastRenewedAt };
    notify();
    return false;
  }
}

/** Re-login ~10s before expiry; on failure the state flips to locked. */
function armRenewal(principal: string): void {
  if (renewTimer) clearTimeout(renewTimer);
  if (!state.expiresAt) return;
  const delay = Math.max(1_000, state.expiresAt - Date.now() - 10_000);
  renewTimer = setTimeout(() => void brokerLogin(principal), delay);
}

const isPodsUrl = (input: RequestInfo | URL): boolean => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return url.startsWith('/api/pods') || url.startsWith(`${location.origin}/api/pods`);
};

const isApiUrl = (input: RequestInfo | URL): boolean => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return url.startsWith('/api/') || url.startsWith(`${location.origin}/api/`);
};

/**
 * Probe the serve and, when it brokers keys, login and patch fetch so every
 * /api/pods request carries the lease (401 → one re-login + retry). The
 * patch installs on EVERY serve (it also carries the forced-offline toggle);
 * on plaintext serves it is a passthrough. Idempotent.
 */
export async function installKeyBroker(principal: () => Promise<string>): Promise<BrokerState> {
  if (!installed) {
    installed = true;
    const original = globalThis.fetch.bind(globalThis);
    bareFetch = original;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (forcedOffline && isApiUrl(input)) {
        throw new TypeError('Failed to fetch — forced offline (demo toggle)');
      }
      if (!isPodsUrl(input)) return original(input, init);
      const attempt = () => {
        const req = new Request(input as string | URL, init);
        if (leaseB64) req.headers.set(LEASE_HEADER, leaseB64);
        return original(req);
      };
      let res = await attempt();
      if (res.status === 401 && !released && (await brokerLogin(await principal()))) res = await attempt();
      return res;
    }) as typeof fetch;
  }
  const meta = await probe();
  if (!meta) {
    // unreachable serve: a previously-seen broker shows LOCKED (offline
    // reload), an unknown serve shows nothing
    const known = cachedMeta();
    if (known && state.status === 'none') {
      state = { status: 'locked', meta: known };
      notify();
    }
    return state;
  }
  if (state.status !== 'leased') await brokerLogin(await principal());
  return state;
}
