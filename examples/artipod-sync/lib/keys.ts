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

let state: BrokerState = { status: 'none', meta: null };
let leaseB64: string | null = null;
/** The live signed lease + device-unwrapped KEKs (non-extractable), memory only. */
let currentLease: Lease | null = null;
let podKeys: Record<string, CryptoKey> = {};
let renewTimer: ReturnType<typeof setTimeout> | null = null;
let probePromise: Promise<KeysMeta | null> | null = null;
let installed = false;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

export function getBrokerState(): BrokerState {
  return state;
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

/** The bare fetch, untouched by the lease patch (avoids recursion). */
const rawFetch: typeof fetch = (...args) => bareFetch(...args);
let bareFetch: typeof fetch = (...args) => globalThis.fetch(...args);

async function probe(): Promise<KeysMeta | null> {
  probePromise ??= (async () => {
    try {
      const res = await rawFetch('/api/keys');
      return res.ok ? ((await res.json()) as KeysMeta) : null;
    } catch {
      return null;
    }
  })();
  return probePromise;
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

/**
 * Probe the serve and, when it brokers keys, login and patch fetch so every
 * /api/pods request carries the lease (401 → one re-login + retry).
 * Idempotent — call from any entry point.
 */
export async function installKeyBroker(principal: () => Promise<string>): Promise<BrokerState> {
  const meta = await probe();
  if (!meta) return state; // plaintext serve — zero overhead, no patch
  if (!installed) {
    installed = true;
    const original = globalThis.fetch.bind(globalThis);
    bareFetch = original;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!isPodsUrl(input)) return original(input, init);
      const attempt = () => {
        const req = new Request(input as string | URL, init);
        if (leaseB64) req.headers.set(LEASE_HEADER, leaseB64);
        return original(req);
      };
      let res = await attempt();
      if (res.status === 401 && (await brokerLogin(await principal()))) res = await attempt();
      return res;
    }) as typeof fetch;
  }
  if (state.status !== 'leased') await brokerLogin(await principal());
  return state;
}
