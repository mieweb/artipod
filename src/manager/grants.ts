/**
 * Offline grants (docs/encryption.md "Offline grants"): device enrollment,
 * ceremony-gated unlock, monotonic clock discipline, CRL revocation.
 */
import { verifyJson, unwrapKeyForDevice, type DeviceKeyPair } from './crypto.js';
import type { OfflineGrant, SignedCrl } from './authority.js';
import type { Keyring } from './keyring.js';

export { generateDeviceKeyPair as enrollDevice } from './crypto.js';
export type { DeviceKeyPair } from './crypto.js';

/**
 * Monotonic high-water mark of observed time. `persist` is app-supplied
 * (localStorage/IndexedDB/file); refusing key release on rollback is the
 * whole point — a wound-back clock must not resurrect an expired grant.
 */
export class HighWaterClock {
  constructor(
    private highWater: number,
    private readonly persist: (t: number) => void,
    private readonly source: () => number = Date.now,
  ) {}

  /** Current time; throws on observed rollback. */
  now(): number {
    const t = this.source();
    if (t < this.highWater) {
      throw new Error(`clock rollback detected (${new Date(t).toISOString()} < high-water ${new Date(this.highWater).toISOString()}) — refusing key release`);
    }
    this.highWater = t;
    this.persist(t);
    return t;
  }
}

export interface UnlockOptions {
  grant: OfflineGrant;
  device: DeviceKeyPair;
  /** Root (or issuing) authority verify key. */
  authorityPublicKey: string;
  /** The local ceremony — passkey tap / PIN. Must resolve true. */
  ceremony: () => Promise<boolean>;
  clock: HighWaterClock;
  keyring: Keyring;
  /** Latest CRL seen on sync, if any. */
  crl?: SignedCrl;
}

/**
 * Validate an offline grant and release its KEKs into the keyring with a
 * grant-bounded expiry. Every failure path releases nothing.
 */
export async function unlockWithGrant(opts: UnlockOptions): Promise<string[]> {
  const { grant, device } = opts;
  if (!(await verifyJson(grant, opts.authorityPublicKey))) throw new Error('offline grant signature fails verification');
  if (opts.crl) {
    if (!(await verifyJson(opts.crl, opts.authorityPublicKey))) throw new Error('CRL signature fails verification');
    if (opts.crl.revokedGrantIds.includes(grant.id)) throw new Error(`grant ${grant.id} has been revoked`);
  }
  if (grant.device !== device.id) throw new Error(`grant is for ${grant.device}, this device is ${device.id}`);
  const now = opts.clock.now(); // throws on rollback
  if (now < Date.parse(grant.notBefore)) throw new Error('grant not yet valid');
  if (now >= Date.parse(grant.expires)) throw new Error('grant expired');
  if (!(await opts.ceremony())) throw new Error('unlock ceremony failed or was cancelled');

  const unlocked: string[] = [];
  for (const [podId, wrapped] of Object.entries(grant.wrappedKeys)) {
    const key = await unwrapKeyForDevice(wrapped, device.privateKey);
    opts.keyring.put({
      name: `kek:${podId}`,
      kind: 'kek',
      key,
      expiresAt: Date.parse(grant.expires),
      meta: { via: grant.id, permissions: grant.permissions.join(',') },
    });
    unlocked.push(podId);
  }
  return unlocked;
}
