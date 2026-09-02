/**
 * Authorities, leases, and delegation certificates (docs/encryption.md).
 *
 * An `Authority` is the root custodian: it holds raw pod KEKs (server/KMS
 * side), signs leases, issues delegation certs, offline grants, policy and
 * CRLs. A `DelegatedAuthority` holds a cert from a parent and issues leases
 * fully offline within its scope — verification is pure signature-chain
 * checking, no round trips.
 */
import {
  canonicalJson,
  fromBase64,
  generateSigningKeyPair,
  scopeMatch,
  signJson,
  toBase64,
  verifyJson,
  wrapKeyForDevice,
  type SigningKeyPair,
  type WrappedKey,
} from './crypto.js';

export interface Lease {
  formatVersion: 1;
  podIds: string[];
  principal: string;
  permissions: string[];
  issuedAt: string;
  expiresAt: string;
  issuer: string;
  /** Delegation chain, root-first. Empty/absent = signed by the root. */
  chain?: DelegationCert[];
  sig?: string;
}

export interface DelegationCert {
  formatVersion: 1;
  subject: string;
  scope: { pods: string; principals: string };
  maxLeaseTtlMs: number;
  grantIssuance: boolean;
  validity: [string, string];
  /** The subject's verify key — what the next link in the chain checks against. */
  publicKey: string;
  sig?: string;
}

export interface OfflineGrant {
  formatVersion: 1;
  id: string;
  pods: string[];
  device: string;
  permissions: string[];
  notBefore: string;
  expires: string;
  maximumSnapshot?: string;
  allowExport: boolean;
  /** podId → KEK wrapped to the device public key. */
  wrappedKeys: Record<string, WrappedKey>;
  issuer: string;
  sig?: string;
}

export interface SignedCrl {
  formatVersion: 1;
  revokedGrantIds: string[];
  issuedAt: string;
  sig?: string;
}

export interface LoginResult {
  lease: Lease;
  /** podId → raw KEK bytes. In deployments this crosses an authenticated channel once. */
  keys: Record<string, Uint8Array>;
}

/** LoginResult as JSON carries it (serve `/api/keys/login`): keys in base64. */
export interface WireLoginResult {
  lease: Lease;
  keys: Record<string, string>;
}

export function encodeLoginResult(result: LoginResult): WireLoginResult {
  return {
    lease: result.lease,
    keys: Object.fromEntries(Object.entries(result.keys).map(([id, raw]) => [id, toBase64(raw)])),
  };
}

export function decodeLoginResult(wire: WireLoginResult): LoginResult {
  return {
    lease: wire.lease,
    keys: Object.fromEntries(Object.entries(wire.keys).map(([id, b64]) => [id, fromBase64(b64)])),
  };
}

const randomId = (): string => {
  const buf = new Uint8Array(8);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
};

export class Authority {
  private podKeks = new Map<string, Uint8Array>();

  private constructor(
    readonly name: string,
    private readonly keys: SigningKeyPair,
    private readonly clock: () => number,
  ) {}

  static async create(name: string, clock: () => number = Date.now): Promise<Authority> {
    return new Authority(name, await generateSigningKeyPair(), clock);
  }

  /** Rehydrate from persisted keys (serve `--authority <dir>`). */
  static from(name: string, keys: SigningKeyPair, clock: () => number = Date.now): Authority {
    return new Authority(name, keys, clock);
  }

  get publicKey(): string {
    return this.keys.publicKeyB64;
  }

  /** Pods this authority holds KEKs for. */
  get podIds(): string[] {
    return [...this.podKeks.keys()];
  }

  hasPod(podId: string): boolean {
    return this.podKeks.has(podId);
  }

  /** Custodial registration; generates a KEK when none is given. */
  registerPod(podId: string, rawKek?: Uint8Array): Uint8Array {
    const kek = rawKek ?? globalThis.crypto.getRandomValues(new Uint8Array(32));
    this.podKeks.set(podId, kek);
    return kek;
  }

  /** The login path: authenticate out-of-band, then lease + KEK release. */
  async login(opts: { principal: string; podIds: string[]; ttlMs: number; permissions?: string[] }): Promise<LoginResult> {
    const keys: Record<string, Uint8Array> = {};
    for (const podId of opts.podIds) {
      const kek = this.podKeks.get(podId);
      if (!kek) throw new Error(`authority '${this.name}' has no KEK for pod '${podId}'`);
      keys[podId] = kek;
    }
    const lease = await signJson<Lease>(
      {
        formatVersion: 1,
        podIds: opts.podIds,
        principal: opts.principal,
        permissions: opts.permissions ?? ['mount', 'read', 'write'],
        issuedAt: new Date(this.clock()).toISOString(),
        expiresAt: new Date(this.clock() + opts.ttlMs).toISOString(),
        issuer: this.name,
      },
      this.keys.privateKey,
    );
    return { lease, keys };
  }

  async delegate(opts: {
    subject: string;
    subjectPublicKey: string;
    scope: { pods: string; principals: string };
    maxLeaseTtlMs: number;
    grantIssuance?: boolean;
    validityMs: number;
  }): Promise<DelegationCert> {
    return signJson<DelegationCert>(
      {
        formatVersion: 1,
        subject: opts.subject,
        scope: opts.scope,
        maxLeaseTtlMs: opts.maxLeaseTtlMs,
        grantIssuance: opts.grantIssuance ?? false,
        validity: [new Date(this.clock()).toISOString(), new Date(this.clock() + opts.validityMs).toISOString()],
        publicKey: opts.subjectPublicKey,
      },
      this.keys.privateKey,
    );
  }

  /** Offline grant: pod KEKs wrapped to the device, signed (docs/encryption.md). */
  async issueGrant(opts: {
    pods: string[];
    device: string;
    devicePublicKey: string;
    permissions?: string[];
    notBeforeMs?: number;
    expiresMs: number;
    maximumSnapshot?: string;
    allowExport?: boolean;
  }): Promise<OfflineGrant> {
    const wrappedKeys: Record<string, WrappedKey> = {};
    for (const podId of opts.pods) {
      const kek = this.podKeks.get(podId);
      if (!kek) throw new Error(`authority '${this.name}' has no KEK for pod '${podId}'`);
      wrappedKeys[podId] = await wrapKeyForDevice(kek, opts.devicePublicKey);
    }
    return signJson<OfflineGrant>(
      {
        formatVersion: 1,
        id: `grant:${randomId()}`,
        pods: opts.pods,
        device: opts.device,
        permissions: opts.permissions ?? ['mount', 'read', 'write'],
        notBefore: new Date(this.clock() + (opts.notBeforeMs ?? 0)).toISOString(),
        expires: new Date(this.clock() + opts.expiresMs).toISOString(),
        ...(opts.maximumSnapshot ? { maximumSnapshot: opts.maximumSnapshot } : {}),
        allowExport: opts.allowExport ?? false,
        wrappedKeys,
        issuer: this.name,
      },
      this.keys.privateKey,
    );
  }

  async signCrl(revokedGrantIds: string[]): Promise<SignedCrl> {
    return signJson<SignedCrl>(
      { formatVersion: 1, revokedGrantIds, issuedAt: new Date(this.clock()).toISOString() },
      this.keys.privateKey,
    );
  }

  async sign<T extends { sig?: string }>(doc: T): Promise<T> {
    return signJson(doc, this.keys.privateKey);
  }
}

/** A scoped sub-authority (ship/station manager) issuing leases offline. */
export class DelegatedAuthority {
  private constructor(
    readonly cert: DelegationCert,
    private readonly keys: SigningKeyPair,
    /** Certs between the root and this one, root-first (usually empty). */
    private readonly parentChain: DelegationCert[],
    private readonly clock: () => number,
  ) {}

  /** Generate the subject keypair first, get it certified, then construct. */
  static async createKeys(): Promise<SigningKeyPair> {
    return generateSigningKeyPair();
  }

  static from(cert: DelegationCert, keys: SigningKeyPair, parentChain: DelegationCert[] = [], clock: () => number = Date.now): DelegatedAuthority {
    if (cert.publicKey !== keys.publicKeyB64) throw new Error('delegation cert does not certify this keypair');
    return new DelegatedAuthority(cert, keys, parentChain, clock);
  }

  /** Fully offline: scope-checked, TTL clamped to the cert, chain attached. */
  async issueLease(opts: { principal: string; podIds: string[]; ttlMs: number; permissions?: string[] }): Promise<Lease> {
    for (const podId of opts.podIds) {
      if (!scopeMatch(this.cert.scope.pods, podId)) {
        throw new Error(`pod '${podId}' outside delegated scope '${this.cert.scope.pods}'`);
      }
    }
    if (!scopeMatch(this.cert.scope.principals, opts.principal)) {
      throw new Error(`principal '${opts.principal}' outside delegated scope '${this.cert.scope.principals}'`);
    }
    const ttlMs = Math.min(opts.ttlMs, this.cert.maxLeaseTtlMs);
    return signJson<Lease>(
      {
        formatVersion: 1,
        podIds: opts.podIds,
        principal: opts.principal,
        permissions: opts.permissions ?? ['mount', 'read'],
        issuedAt: new Date(this.clock()).toISOString(),
        expiresAt: new Date(this.clock() + ttlMs).toISOString(),
        issuer: this.cert.subject,
        chain: [...this.parentChain, this.cert],
      },
      this.keys.privateKey,
    );
  }
}

/**
 * Verify a lease against the root public key alone: walk the delegation
 * chain (root signs cert 0, cert i signs cert i+1, the last link signs the
 * lease), enforcing scope, validity windows and TTL clamps at every hop.
 */
export async function verifyLease(lease: Lease, rootPublicKey: string, now: number = Date.now()): Promise<void> {
  if (Date.parse(lease.expiresAt) <= now) throw new Error('lease expired');
  const chain = lease.chain ?? [];
  let signerKey = rootPublicKey;
  for (const cert of chain) {
    if (!(await verifyJson(cert, signerKey))) throw new Error(`delegation cert for '${cert.subject}' fails verification`);
    const [from, to] = cert.validity.map((d) => Date.parse(d));
    if (now < from || now > to) throw new Error(`delegation cert for '${cert.subject}' outside validity window`);
    for (const podId of lease.podIds) {
      if (!scopeMatch(cert.scope.pods, podId)) throw new Error(`pod '${podId}' outside scope of '${cert.subject}'`);
    }
    if (!scopeMatch(cert.scope.principals, lease.principal)) {
      throw new Error(`principal '${lease.principal}' outside scope of '${cert.subject}'`);
    }
    if (Date.parse(lease.expiresAt) - Date.parse(lease.issuedAt) > cert.maxLeaseTtlMs) {
      throw new Error(`lease TTL exceeds '${cert.subject}' clamp`);
    }
    signerKey = cert.publicKey;
  }
  if (!(await verifyJson(lease, signerKey))) throw new Error('lease signature fails verification');
}

/** Debug/audit helper: the canonical form a signature covers. */
export function leaseCanonical(lease: Lease): string {
  const { sig: _s, ...unsigned } = lease;
  return canonicalJson(unsigned);
}
