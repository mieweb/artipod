/**
 * KeysService behavior parity (spa-ui-plan U1): the scenarios this week's
 * live debugging proved matter, replayed against fake fetch + memory kv —
 * zero React, zero DOM, plain node (the client-lib guarantee, P10).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Authority } from '@artipod/core/manager';
import { KeysService as CoreKeysService } from '@artipod/core/storage';
import { createKeysHandler } from '@artipod/core/server';
import { KeysService, RENEW_TASK } from '../lib/services/keys-service';
import { nodeAdapters, type ServiceAdapters } from '../lib/services/adapters';
import { brokerStore } from '../lib/stores/broker';
import { settingsStore } from '../lib/stores/settings';

const POD_ID = 'pod0000000000001';

/** A REAL broker (core's keys handler) behind a fake network — full ECDH round-trip. */
async function realBroker(keyByte = 7): Promise<typeof fetch> {
  const authority = await Authority.create('test-authority');
  authority.registerPod(POD_ID, new Uint8Array(32).fill(keyByte));
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
  it('bridges core snapshots without treating offline changes as broker changes', async () => {
    adapters.fetch = await realBroker();
    const svc = new KeysService(adapters);
    expect(svc).toBeInstanceOf(CoreKeysService);
    await svc.login('tester');
    expect(brokerStore.getState()).toBe(svc.getSnapshot());
    expect(settingsStore.getState()).toBe(svc.getSettingsSnapshot());
    const brokerChanged = vi.fn();
    const settingsChanged = vi.fn();
    const offBroker = brokerStore.subscribe(brokerChanged);
    const offSettings = settingsStore.subscribe(settingsChanged);
    try {
      svc.setForcedOffline(true);
      expect(settingsChanged).toHaveBeenCalledOnce();
      expect(brokerChanged).not.toHaveBeenCalled();
      expect(settingsStore.getState()).toBe(svc.getSettingsSnapshot());
      settingsChanged.mockClear();
      svc.release();
      expect(brokerChanged).toHaveBeenCalledOnce();
      expect(settingsChanged).not.toHaveBeenCalled();
      expect(brokerStore.getState()).toBe(svc.getSnapshot());
    } finally {
      offBroker();
      offSettings();
      svc.scheduler.dispose();
    }
  });

  it('drains pending grant writes and blocks later renewal/device persistence during reset', async () => {
    adapters.fetch = await realBroker();
    const svc = new KeysService(adapters);
    await svc.install(async () => 'tester');
    const liveKey = svc.getKey();
    const put = adapters.kv.put;
    let started!: () => void;
    const pendingWrite = new Promise<void>(resolve => { started = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    let writes = 0;
    adapters.kv.put = async (key, value) => {
      writes += 1;
      started();
      await gate;
      await put(key, value);
    };
    const renewal = svc.login('tester');
    await pendingWrite;
    let suspended = false;
    const resetting = svc.suspendForReset().then(result => { suspended = true; return result; });
    await Promise.resolve();
    expect(suspended).toBe(false);
    expect(svc.getKey()).toBe(liveKey); // The owned vault can still flush.
    finish();
    const forgetKeys = await resetting;
    expect(await renewal).toBe(false);
    await put('session', undefined); // The reset erases storage only after draining.
    await put('keypair', undefined);
    const before = writes;
    expect(await svc.login('tester')).toBe(false);
    await svc.scheduler.run(RENEW_TASK);
    forgetKeys();
    expect(svc.getKey()).toBeNull();
    await expect(svc.install(async () => 'tester')).rejects.toThrow('suspended for browser reset');
    expect(await adapters.kv.get('session')).toBeUndefined();
    expect(await adapters.kv.get('keypair')).toBeUndefined();
    expect(writes).toBe(before);
    svc.scheduler.dispose();
  });

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
    expect(second.storagePolicy).toBe('encrypted');
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
    expect(svc.storagePolicy).toBe('unknown');
    expect(svc.probeError).toBe('down');
    networkUp = true;
    expect(await svc.login('tester')).toBe(true);
    expect(svc.storagePolicy).toBe('encrypted');
    expect(svc.probeError).toBeNull();
    svc.scheduler.dispose();
  });

  it('only a definitive 404 identifies a plaintext service, without initializing a principal', async () => {
    adapters.fetch = async () => new Response('not found', { status: 404 });
    const principal = vi.fn(async () => 'must-not-open-storage');
    const svc = new KeysService(adapters);
    expect((await svc.install(principal)).status).toBe('none');
    expect(svc.storagePolicy).toBe('plaintext');
    expect(svc.probeError).toBeNull();
    expect(principal).not.toHaveBeenCalled();
    expect(await adapters.kv.get('session')).toBeUndefined();
    svc.scheduler.dispose();
  });

  it('a server error is unknown policy and can recover on the next probe', async () => {
    const broker = await realBroker();
    let unavailable = true;
    adapters.fetch = ((...args) => unavailable
      ? Promise.resolve(new Response('temporary outage', { status: 503 }))
      : broker(...args)) as typeof fetch;
    const svc = new KeysService(adapters);
    expect((await svc.install(async () => 'tester')).status).toBe('none');
    expect(svc.storagePolicy).toBe('unknown');
    expect(svc.probeError).toMatch(/503/);
    unavailable = false;
    expect((await svc.install(async () => 'tester')).status).toBe('leased');
    expect(svc.storagePolicy).toBe('encrypted');
    svc.scheduler.dispose();
  });

  it('a synchronous network failure is retried rather than cached as plaintext', async () => {
    const broker = await realBroker();
    let unavailable = true;
    adapters.fetch = ((...args: Parameters<typeof fetch>) => {
      if (unavailable) throw new TypeError('blocked');
      return broker(...args);
    }) as typeof fetch;
    const svc = new KeysService(adapters);
    expect(await svc.login('tester')).toBe(false);
    expect(svc.storagePolicy).toBe('unknown');
    unavailable = false;
    expect(await svc.login('tester')).toBe(true);
    svc.scheduler.dispose();
  });

  it('malformed successful probe responses do not authorize plaintext storage', async () => {
    adapters.fetch = async () => Response.json({ not: 'broker metadata' });
    const svc = new KeysService(adapters);
    await svc.install(async () => 'tester');
    expect(svc.storagePolicy).toBe('unknown');
    expect(svc.probeError).toMatch(/invalid metadata/);
    expect(svc.getKey()).toBeNull();
    svc.scheduler.dispose();
  });

  it('checks actual expiry on access even when background timers have not run', async () => {
    adapters.fetch = await realBroker();
    let now = Date.now();
    adapters.now = () => now;
    const svc = new KeysService(adapters);
    await svc.login('tester');
    expect(svc.getKey()).toBeInstanceOf(CryptoKey);
    now = brokerStore.getState().expiresAt as number;
    expect(svc.getLease()).toBeNull();
    expect(svc.getKey()).toBeNull();
    expect(() => svc.requireKey()).toThrow(/locked/);
    expect(brokerStore.getState().status).toBe('locked');
    expect(await adapters.kv.get('session')).toBeUndefined();
    svc.scheduler.dispose();
  });

  it('release while login is in flight cannot restore keys or a persisted grant', async () => {
    const broker = await realBroker();
    let responseReady!: () => void;
    const ready = new Promise<void>((resolve) => { responseReady = resolve; });
    let continueLogin!: () => void;
    const delayed = new Promise<void>((resolve) => { continueLogin = resolve; });
    adapters.fetch = (async (...args: Parameters<typeof fetch>) => {
      const response = await broker(...args);
      const input = args[0];
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/keys/login')) {
        responseReady();
        await delayed;
      }
      return response;
    }) as typeof fetch;
    const svc = new KeysService(adapters);
    const pending = svc.login('tester');
    await ready;
    svc.release();
    continueLogin();
    expect(await pending).toBe(false);
    expect(svc.getKey()).toBeNull();
    expect(brokerStore.getState().status).toBe('locked');
    expect(await adapters.kv.get('session')).toBeUndefined();
    svc.scheduler.dispose();
  });

  it('same-secret renewal retains the live key object, but login after release imports a new one', async () => {
    adapters.fetch = await realBroker();
    const svc = new KeysService(adapters);
    await svc.login('tester');
    const original = svc.getKey();
    expect(await svc.login('tester')).toBe(true);
    expect(svc.getKey()).toBe(original);
    svc.release();
    expect(svc.getKey()).toBeNull();
    expect(await svc.login('tester')).toBe(true);
    expect(svc.getKey()).not.toBe(original);
    expect(svc.getKey()).toBeInstanceOf(CryptoKey);
    svc.scheduler.dispose();
  });

  it('an immediate reload cannot restore or auto-login a released grant while IndexedDB deletion is pending', async () => {
    adapters.fetch = await realBroker();
    const first = new KeysService(adapters);
    await first.install(async () => 'tester');
    const put = adapters.kv.put;
    let finishDelete!: () => void;
    adapters.kv.put = (key, value) => key === 'session' && value === undefined
      ? new Promise<void>((resolve) => { finishDelete = () => { void put(key, value).then(resolve); }; })
      : put(key, value);
    first.release();
    expect(await adapters.kv.get('session')).toBeDefined(); // The old grant still exists.
    brokerStore.setState({ status: 'none', meta: null }, true); // Real reload resets the module store.
    const second = new KeysService(adapters);
    expect((await second.install(async () => 'tester')).status).toBe('locked');
    expect(brokerStore.getState().meta?.podIds).toEqual([POD_ID]);
    expect(second.getKey()).toBeNull();
    expect(adapters.mirror.get('artipod-lease-released')).toBe('1');
    finishDelete();
    adapters.kv.put = put;
    expect(await second.login('tester')).toBe(true);
    expect(adapters.mirror.get('artipod-lease-released')).toBeNull();
    first.scheduler.dispose();
    second.scheduler.dispose();
  });

  it('a broker returning a different secret locks the current store before adopting or persisting it', async () => {
    adapters.fetch = await realBroker();
    const svc = new KeysService(adapters);
    await svc.login('tester');
    adapters.fetch = await realBroker(9);
    expect(await svc.login('tester')).toBe(false);
    expect(svc.getKey()).toBeNull();
    expect(brokerStore.getState().status).toBe('locked');
    expect(svc.probeError).toMatch(/encryption key changed/);
    expect(await adapters.kv.get('session')).toBeUndefined();
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

  it('retains an explicit reconnect after a locked write fails and retries before stale settings can win', async () => {
    const svc = new KeysService(adapters);
    let locked = true;
    let saved = true;
    svc.setOfflineWriter(async value => {
      if (locked) throw new Error('EACCES: pod locked');
      saved = value;
    });
    svc.reconcileOffline(true);
    svc.setForcedOffline(false);
    await expect(svc.flushOfflinePreference()).rejects.toThrow('pod locked');
    svc.reconcileOffline(saved);
    expect(svc.forcedOffline).toBe(false);
    expect(adapters.mirror.get('artipod-forced-offline')).toBeNull();
    expect(saved).toBe(true);
    locked = false;
    await svc.flushOfflinePreference();
    expect(saved).toBe(false);
    svc.reconcileOffline(saved);
    expect(svc.forcedOffline).toBe(false);
    // Successful persistence clears the pending override: later shell edits
    // are once again allowed to update the chip.
    svc.reconcileOffline(true);
    expect(svc.forcedOffline).toBe(true);
    svc.scheduler.dispose();
  });

  it('serializes toggles and persists the latest choice after an in-flight write', async () => {
    const svc = new KeysService(adapters);
    const writes: boolean[] = [];
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const writer = vi.fn(async (value: boolean) => {
      writes.push(value);
      if (writes.length === 1) await gate;
    });
    svc.setOfflineWriter(writer);
    svc.setForcedOffline(true);
    await vi.waitFor(() => expect(writer).toHaveBeenCalledOnce());
    svc.setForcedOffline(false);
    svc.reconcileOffline(true);
    expect(svc.forcedOffline).toBe(false);
    expect(writes).toEqual([true]);
    finish();
    await svc.flushOfflinePreference();
    expect(writes).toEqual([true, false]);
    expect(svc.forcedOffline).toBe(false);
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
  it('first explicit login succeeds after expiry even if the old timer has not run', async () => {
    vi.useFakeTimers();
    try {
      adapters.fetch = await realBroker();
      const svc = new KeysService(adapters);
      await svc.login('tester');
      const oldExpiry = brokerStore.getState().expiresAt as number;
      vi.setSystemTime(oldExpiry + 1);
      expect(await svc.login('tester')).toBe(true);
      expect(brokerStore.getState().status).toBe('leased');
      expect(brokerStore.getState().expiresAt).toBeGreaterThan(oldExpiry);
      svc.scheduler.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('locks on lease expiry after an offline renewal fails, without an access call', async () => {
    vi.useFakeTimers();
    try {
      adapters.fetch = await realBroker();
      const svc = new KeysService(adapters);
      await svc.install(async () => 'tester');
      const expiresAt = brokerStore.getState().expiresAt as number;
      svc.setForcedOffline(true);
      await vi.advanceTimersByTimeAsync(expiresAt - Date.now() - 5_000);
      expect(brokerStore.getState().status).toBe('leased');
      expect(brokerStore.getState().renewing).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(brokerStore.getState().status).toBe('locked');
      expect(svc.getKey()).toBeNull();
      expect(await adapters.kv.get('session')).toBeUndefined();
      svc.scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

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
