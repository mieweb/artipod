/**
 * Client for a broker serve's /api/keys surface (serve plan S5.5, V9/V10):
 * probe once, auto-login (open localhost serves need no credentials), keep
 * the signed lease IN MEMORY ONLY, attach it to every same-origin /api/pods
 * request, retry once on 401, and re-login shortly before expiry.
 *
 * One fetch patch covers the whole app — the scattered raw fetch('/api/pods…')
 * calls AND HttpPodStore (it dereferences globalThis.fetch at call time).
 */

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
}

interface Lease {
  principal: string;
  expiresAt: string;
  [k: string]: unknown;
}

const LEASE_HEADER = 'x-artipod-lease';

let state: BrokerState = { status: 'none', meta: null };
let leaseB64: string | null = null;
let renewTimer: ReturnType<typeof setTimeout> | null = null;
let probePromise: Promise<KeysMeta | null> | null = null;
let installed = false;
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((l) => l());

export function getBrokerState(): BrokerState {
  return state;
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

/** Login against the broker; principal is the catalog's LWW actor id. */
export async function brokerLogin(principal: string): Promise<boolean> {
  const meta = await probe();
  if (!meta) return false;
  try {
    const res = await rawFetch('/api/keys/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ principal }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const { lease } = (await res.json()) as { lease: Lease };
    leaseB64 = btoa(JSON.stringify(lease));
    state = { status: 'leased', meta, principal: lease.principal, expiresAt: Date.parse(lease.expiresAt) };
    armRenewal(principal);
    notify();
    return true;
  } catch {
    // token-gated broker (or network): the badge shows locked; retry via the badge
    leaseB64 = null;
    state = { status: 'locked', meta };
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
