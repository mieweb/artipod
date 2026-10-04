/**
 * Phase 6.5 — keyring, leases, delegation, offline grants
 * (docs/encryption.md is normative). Covers the done-when bullets:
 * lease expiry locks → EACCES → login restores WITHOUT data rewrite;
 * delegated manager issues a valid lease fully offline; offline grant
 * survives "reload", unlocks only via ceremony, expires by grant time,
 * refuses on clock rollback.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import { OciStore, OCI_ROOT } from '../oci/store.js';
import { Keyring, PodLockedError, makeKeysProcProvider } from './keyring.js';
import { Authority, DelegatedAuthority, verifyLease, type Lease } from './authority.js';
import { PodLocker, kekName } from './locker.js';
import { enrollDevice, HighWaterClock, unlockWithGrant } from './grants.js';
import { AuditLog } from './audit.js';

const text = (s: string) => new TextEncoder().encode(s);

function unmountAll() {
  for (const path of [...zenMounts.keys()]) {
    if (path !== '/') umount(path);
  }
  try {
    umount('/');
  } catch {
    // first run
  }
}

let store: OciStore;
let now: number;
const clock = () => now;

beforeEach(async () => {
  unmountAll();
  await configure({ mounts: { '/': InMemory } });
  store = new OciStore(zfs);
  await store.init();
  now = Date.parse('2026-06-01T12:00:00Z');
});

describe('lease lifecycle: expiry locks, login restores, no data rewrite', () => {
  it('walks the full lock/restore cycle against real ciphertext', async () => {
    const authority = await Authority.create('home-base', clock);
    const podId = store.getSuperblock().podId;
    authority.registerPod(podId);

    const keyring = new Keyring(clock);
    const audit = new AuditLog(store);
    const locker = new PodLocker({ keyring, stores: new Map([[podId, store]]), audit, clock });

    // Login BEFORE binding encryption: the store needs a key to write.
    const login1 = await authority.login({ principal: 'user:alice', podIds: [podId], ttlMs: 60_000 });
    await verifyLease(login1.lease, authority.publicKey, now);
    await locker.adoptLogin(login1);
    await locker.bind(podId);

    const digest = await store.putBlob(text('clinical note: patient stable'));
    expect(new TextDecoder().decode(await store.getBlob(digest))).toContain('patient stable');

    // The bytes on disk are ciphertext, addressed via the alias.
    const cipherDigest = await store.resolveAlias(digest);
    expect(cipherDigest).not.toBeNull();
    const cipherBefore = await store.getRawBlob(cipherDigest!);
    expect(new TextDecoder().decode(cipherBefore)).not.toContain('patient stable');

    // Lease expiry = the key evaporates. Reads fail EACCES with the hint.
    now += 61_000;
    expect(store.locked).toBe(true);
    await expect(store.getBlob(digest)).rejects.toThrow(PodLockedError);
    await expect(store.getBlob(digest)).rejects.toThrow(/EACCES.*artipod login/);
    // New writes are refused too — nothing plaintext can land.
    await expect(store.putBlob(text('x'))).rejects.toThrow(PodLockedError);

    // "Access expires" was NOT done to the data: ciphertext untouched.
    const cipherAfter = await store.getRawBlob(cipherDigest!);
    expect(cipherAfter).toEqual(cipherBefore);

    // Login restores — same data, zero rewrite.
    await locker.adoptLogin(await authority.login({ principal: 'user:alice', podIds: [podId], ttlMs: 60_000 }));
    expect(store.locked).toBe(false);
    expect(new TextDecoder().decode(await store.getBlob(digest))).toContain('patient stable');
    expect(await store.getRawBlob(cipherDigest!)).toEqual(cipherBefore);

    // Provenance recorded the lifecycle.
    const kinds = (await audit.read()).map((e) => e.kind);
    expect(kinds).toEqual(['login', 'login']);
  });

  it('artipod lock drops keys immediately; purge mode deletes blobs', async () => {
    const authority = await Authority.create('home-base', clock);
    const podId = store.getSuperblock().podId;
    authority.registerPod(podId);
    const keyring = new Keyring(clock);
    const locker = new PodLocker({ keyring, stores: new Map([[podId, store]]), clock, mode: 'purge' });
    await locker.adoptLogin(await authority.login({ principal: 'user:kiosk', podIds: [podId], ttlMs: 60_000 }));
    await locker.bind(podId);

    const digest = await store.putBlob(text('ephemeral kiosk data'));
    await locker.lock();
    expect(keyring.has(kekName(podId))).toBe(false);
    // Kiosk mode: the ciphertext itself is gone — restore means re-sync.
    await expect(store.getBlob(digest)).rejects.toThrow();
    const blobDir = (await zfs.promises.readdir(`${OCI_ROOT}/blobs/sha256`)) as string[];
    expect(blobDir).toEqual([]);
  });

  it('/proc/keys shows names + expiries and never key material', async () => {
    const keyring = new Keyring(clock);
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    keyring.put({ name: 'kek:pod-a', kind: 'kek', key, expiresAt: now + 30_000 });
    const provider = makeKeysProcProvider(keyring);
    const tree = await provider.read();
    expect(tree.keys).toContain('kek:pod-a');
    expect(tree.keys).toContain('2026-06-01T12:00:30.000Z');
    expect(JSON.parse(tree['keys.json'] as string)[0]).not.toHaveProperty('key');
  });
});

describe('delegated authority: offline lease issuance', () => {
  it('issues a scoped, clamped lease verifiable by signature chain alone', async () => {
    const root = await Authority.create('org-root', clock);
    const shipKeys = await DelegatedAuthority.createKeys();
    const cert = await root.delegate({
      subject: 'manager:ship-7',
      subjectPublicKey: shipKeys.publicKeyB64,
      scope: { pods: 'clinical/*', principals: 'crew/*' },
      maxLeaseTtlMs: 30 * 60_000,
      validityMs: 7 * 24 * 3_600_000,
    });
    const ship = DelegatedAuthority.from(cert, shipKeys, [], clock);

    // No root round-trip from here on — pure signature-chain verification.
    const lease = await ship.issueLease({ principal: 'crew/nurse-1', podIds: ['clinical/rig-visits'], ttlMs: 2 * 3_600_000 });
    await verifyLease(lease, root.publicKey, now);
    // TTL clamped to the cert's 30 minutes despite the 2 h ask.
    expect(Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt)).toBe(30 * 60_000);

    // Scope is enforced at issuance…
    await expect(ship.issueLease({ principal: 'crew/nurse-1', podIds: ['payroll/q3'], ttlMs: 60_000 })).rejects.toThrow(/outside delegated scope/);
    await expect(ship.issueLease({ principal: 'passenger/bob', podIds: ['clinical/rig-visits'], ttlMs: 60_000 })).rejects.toThrow(/outside delegated scope/);

    // …and again at verification: a tampered lease dies on the chain.
    const forged: Lease = { ...lease, podIds: ['payroll/q3'] };
    await expect(verifyLease(forged, root.publicKey, now)).rejects.toThrow();
    const expired = { ...lease };
    await expect(verifyLease(expired, root.publicKey, now + 31 * 60_000)).rejects.toThrow(/expired/);
    const wrongRoot = await Authority.create('imposter', clock);
    await expect(verifyLease(lease, wrongRoot.publicKey, now)).rejects.toThrow();
  });
});

describe('offline grants', () => {
  it('unlocks only via ceremony, survives reload, expires, refuses rollback and revocation', async () => {
    const authority = await Authority.create('home-base', clock);
    const podId = store.getSuperblock().podId;
    authority.registerPod(podId);

    const device = await enrollDevice();
    const grant = await authority.issueGrant({
      pods: [podId],
      device: device.id,
      devicePublicKey: device.publicKeyB64,
      expiresMs: 24 * 3_600_000, // the oil-rig profile
    });

    let highWater = now;
    const makeClock = () => new HighWaterClock(highWater, (t) => (highWater = t), clock);

    // Ceremony refusal releases nothing.
    const keyring = new Keyring(clock);
    await expect(
      unlockWithGrant({ grant, device, authorityPublicKey: authority.publicKey, ceremony: async () => false, clock: makeClock(), keyring }),
    ).rejects.toThrow(/ceremony/);
    expect(keyring.list()).toEqual([]);

    // Passkey tap → keys land, bounded by the grant expiry.
    const unlocked = await unlockWithGrant({
      grant,
      device,
      authorityPublicKey: authority.publicKey,
      ceremony: async () => true,
      clock: makeClock(),
      keyring,
    });
    expect(unlocked).toEqual([podId]);
    expect(keyring.list()[0]).toMatchObject({ name: kekName(podId), expiresAt: Date.parse(grant.expires) });

    // The KEK actually decrypts pod data.
    await store.enableEncryption(() => keyring.getKey(kekName(podId)));
    const digest = await store.putBlob(text('offline visit note'));
    expect(new TextDecoder().decode(await store.getBlob(digest))).toContain('offline visit note');

    // "Reload": grant JSON + persisted device keypair, brand-new session.
    const keyring2 = new Keyring(clock);
    const rehydrated = JSON.parse(JSON.stringify(grant));
    await unlockWithGrant({ grant: rehydrated, device, authorityPublicKey: authority.publicKey, ceremony: async () => true, clock: makeClock(), keyring: keyring2 });
    expect(keyring2.has(kekName(podId))).toBe(true);

    // A different device cannot use the grant.
    const otherDevice = await enrollDevice();
    await expect(
      unlockWithGrant({ grant, device: otherDevice, authorityPublicKey: authority.publicKey, ceremony: async () => true, clock: makeClock(), keyring: new Keyring(clock) }),
    ).rejects.toThrow(/this device/);

    // Tampered grant fails signature verification.
    await expect(
      unlockWithGrant({ grant: { ...grant, allowExport: true }, device, authorityPublicKey: authority.publicKey, ceremony: async () => true, clock: makeClock(), keyring: new Keyring(clock) }),
    ).rejects.toThrow(/signature/);

    // Clock rollback: high-water mark refuses key release.
    now += 3_600_000; // observe t+1h
    makeClock().now();
    now -= 2 * 3_600_000; // wind the clock back
    await expect(
      unlockWithGrant({ grant, device, authorityPublicKey: authority.publicKey, ceremony: async () => true, clock: makeClock(), keyring: new Keyring(clock) }),
    ).rejects.toThrow(/rollback/);
    now += 2 * 3_600_000; // forward again

    // Grant expiry.
    now += 25 * 3_600_000;
    await expect(
      unlockWithGrant({ grant, device, authorityPublicKey: authority.publicKey, ceremony: async () => true, clock: makeClock(), keyring: new Keyring(clock) }),
    ).rejects.toThrow(/expired/);
    now -= 25 * 3_600_000;

    // CRL rides the next sync: revoked grant refuses even with ceremony.
    const crl = await authority.signCrl([grant.id]);
    await expect(
      unlockWithGrant({ grant, device, authorityPublicKey: authority.publicKey, ceremony: async () => true, clock: makeClock(), keyring: new Keyring(clock), crl }),
    ).rejects.toThrow(/revoked/);
  });
});
