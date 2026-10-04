/**
 * KeysService behavior parity (spa-ui-plan U1): the scenarios this week's
 * live debugging proved matter, replayed against fake fetch + memory kv —
 * zero React, zero DOM, plain node (the client-lib guarantee, P10).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Authority } from '@artipod/core/manager';
import { createKeysHandler } from '@artipod/core/server';
import { KeysService, RENEW_TASK } from '../lib/services/keys-service';
import { nodeAdapters, type ServiceAdapters } from '../lib/services/adapters';
import { brokerStore } from '../lib/stores/broker';
import { settingsStore } from '../lib/stores/settings';

const POD_ID = 'pod0000000000001';

/** A REAL broker (core's keys handler) behind a fake network — full ECDH round-trip. */
async function realBroker(): Promise<typeof fetch> {
  const authority = await Authority.create('test-authority');
  authority.registerPod(POD_ID, new Uint8Array(32).fill(7));
  const handler = createKeysHandler({ authority, podIds: [POD_ID], capTtlMs: 3600_000 });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const segments = path.split('/').filter(Boolean); // ['api','keys',...]
    const req = new Request(`http://broker${path}`, init ?? (input instanceof Request ? input : undefined));
    return handler(req, segments.slice(2));
  }) as typeof fetch;
}

const failingFetch: typeof fetch = () => Promise.reject(new TypeError('network down'));

let adapters: ServiceAdapters;

beforeEach(() => {
  brokerStore.setState({ status: 'none', meta: null }, true);
  settingsStore.setState({ forcedOffline: false }, true);
  adapters = nodeAdapters();
});

describe('KeysService', () => {
  it('logs in via ECDH: leased snapshot, non-extractable key, no key material in any store', async () => {
    adapters.fetch = await realBroker();
    const svc = new KeysService(adapters);
    expect(await svc.login('tester')).toBe(true);
    const snap = brokerStore.getState();
    expect(snap.status).toBe('leased');
    expect(snap.principal).toBe('tester');
    expect(snap.expiresAt).toBeGreaterThan(Date.now());
    const key = svc.getKey();
    expect(key).toBeInstanceOf(CryptoKey);
    expect((key as CryptoKey).extractable).toBe(false);
    expect(JSON.stringify(snap)).not.toMatch(/CryptoKey|"k"|keyData/);
    svc.scheduler.dispose();
  });

  it('restores a still-valid wrapped session before probing (lease survives reloads)', async () => {
    adapters.fetch = await realBroker();
    const first = new KeysService(adapters);
    await first.login('tester');
    first.scheduler.dispose();
    brokerStore.setState({ status: 'none', meta: null }, true);

    // Same kv (the device), DEAD network: install must restore from the wrapped session.
    const offlineAdapters = { ...adapters, fetch: failingFetch };
    const second = new KeysService(offlineAdapters);
    const snap = await second.install(async () => 'tester');
    expect(snap.status).toBe('leased');
    expect(second.getKey()).toBeInstanceOf(CryptoKey);
    second.scheduler.dispose();
  });

  it('failed probes are NOT memoized — a later login re-probes and succeeds', async () => {
    const real = await realBroker();
    let networkUp = false;
    adapters.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      networkUp ? real(input, init) : Promise.reject(new TypeError('down'))) as typeof fetch;
    const svc = new KeysService(adapters);
    expect(await svc.login('tester')).toBe(false);
    networkUp = true;
    expect(await svc.login('tester')).toBe(true);
    svc.scheduler.dispose();
  });

  it('forced offline blocks even the raw probe/login path and persists to the mirror', async () => {
    adapters.fetch = await realBroker();
    const svc = new KeysService(adapters);
    svc.setForcedOffline(true);
    expect(settingsStore.getState().forcedOffline).toBe(true);
    expect(adapters.mirror.get('artipod-forced-offline')).toBe('1');
    expect(await svc.login('tester')).toBe(false);
    await expect(svc.patchedFetch('/api/pods/refs')).rejects.toThrow(/forced offline/);
    svc.setForcedOffline(false);
    expect(await svc.login('tester')).toBe(true);
    svc.scheduler.dispose();
  });

  it('a new service adopts the mirror at boot (offline survives reloads)', async () => {
    adapters.mirror.set('artipod-forced-offline', '1');
    const svc = new KeysService(adapters);
    expect(settingsStore.getState().forcedOffline).toBe(true);
    svc.scheduler.dispose();
  });

  it('patchedFetch attaches the lease to /api/pods and retries once on 401', async () => {
    const broker = await realBroker();
    const seenLeases: (string | null)[] = [];
    let rejectFirst = true;
    adapters.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const resolved = typeof input === 'string' && input.startsWith('/') ? `http://x${input}` : input;
      const req = new Request(resolved as string | URL, init);
      const url = req.url;
      if (url.includes('/api/keys')) return broker(input, init);
      seenLeases.push(req.headers.get('x-artipod-lease'));
      if (rejectFirst) {
        rejectFirst = false;
        return new Response('unauthorized', { status: 401 });
      }
      return Response.json([]);
    }) as typeof fetch;
    const svc = new KeysService(adapters);
    await svc.install(async () => 'tester');
    seenLeases.length = 0;
    // Expire the tab's lease header knowledge: simulate a 401 → relogin → retry.
    rejectFirst = true;
    const res = await svc.patchedFetch('/api/pods/refs');
    expect(res.status).toBe(200);
    expect(seenLeases.length).toBe(2);
    expect(seenLeases[1]).toBeTruthy(); // the retry carried a fresh lease
    const lease = JSON.parse(atob(seenLeases[1] as string)) as { principal: string };
    expect(lease.principal).toBe('tester');
    svc.scheduler.dispose();
  });

  it('release drops keys + persisted grant and suppresses auto-relogin; explicit login re-arms', async () => {
    adapters.fetch = await realBroker();
    const svc = new KeysService(adapters);
    await svc.install(async () => 'tester');
    expect(brokerStore.getState().status).toBe('leased');

    svc.release();
    expect(brokerStore.getState().status).toBe('locked');
    expect(svc.getKey()).toBeNull();
    expect(await adapters.kv.get('session')).toBeUndefined();

    // 401s no longer trigger relogin while released
    const podRes = await svc.patchedFetch('/api/pods/refs').catch(() => null);
    expect(brokerStore.getState().status).toBe('locked');
    void podRes;

    expect(await svc.login('tester')).toBe(true);
    expect(brokerStore.getState().status).toBe('leased');
    svc.scheduler.dispose();
  });

  it('renewal is a named task visible to artipod ps', async () => {
    adapters.fetch = await realBroker();
    const svc = new KeysService(adapters);
    await svc.login('tester');
    const tasks = svc.scheduler.list();
    const renew = tasks.find((t) => t.name === RENEW_TASK);
    expect(renew).toBeDefined();
    expect(renew?.state).toBe('scheduled');
    expect(renew?.nextRunAt).toBeGreaterThan(Date.now());
    // Manual run = a re-key; lastRenewedAt moves.
    const before = brokerStore.getState().lastRenewedAt ?? 0;
    await new Promise((r) => setTimeout(r, 5));
    await svc.scheduler.run(RENEW_TASK);
    expect(brokerStore.getState().status).toBe('leased');
    expect(brokerStore.getState().lastRenewedAt ?? 0).toBeGreaterThanOrEqual(before);
    svc.scheduler.dispose();
  });

  it('unreachable serve with cached meta shows locked, not nothing', async () => {
    adapters.fetch = await realBroker();
    const first = new KeysService(adapters);
    await first.install(async () => 'tester');
    first.scheduler.dispose();
    brokerStore.setState({ status: 'none', meta: null }, true);
    await adapters.kv.put('session', undefined); // no restorable grant

    const second = new KeysService({ ...adapters, fetch: failingFetch });
    const snap = await second.install(async () => 'tester');
    expect(snap.status).toBe('locked');
    expect(snap.meta?.podIds).toEqual([POD_ID]);
    second.scheduler.dispose();
  });
});

describe('KeysService under fake timers (renewal arming)', () => {
  it('arms the renew task ~10s before expiry', async () => {
    vi.useFakeTimers();
    try {
      adapters.fetch = await realBroker();
      adapters.now = () => Date.now();
      const svc = new KeysService(adapters);
      await svc.login('tester');
      const renew = svc.scheduler.list().find((t) => t.name === RENEW_TASK);
      const expiresAt = brokerStore.getState().expiresAt as number;
      expect(renew?.nextRunAt).toBeGreaterThan(Date.now());
      expect(renew?.nextRunAt).toBeLessThanOrEqual(expiresAt - 9_000);
      svc.scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
