/**
 * /api/keys — the key-broker surface (serve plan S5.5, V9/V10): an HTTP
 * face on the Phase-6.5 `Authority`. Authenticated login → signed lease +
 * raw KEKs (base64 on the wire); the client adopts them into its keyring
 * (`decodeLoginResult` + `PodLocker.adoptLogin`) and encrypts at rest.
 *
 * Stated honestly (V9): a serve that brokers keys CAN decrypt what it
 * brokers. Pure E2E stays available with a keyless serve — encrypted refs
 * sync as opaque ciphertext (blind host) with keys moved out-of-band, and
 * that path needs none of this file.
 */
import { encodeLoginResult, verifyLease, type Authority, type Lease } from '../manager/authority.js';
import { fromBase64 } from '../manager/crypto.js';
import { authorizeAccess, json, type AuthHook, type PathHandler } from './common.js';

/** Signed lease, base64(JSON), presented on lease-gated pod requests. */
export const LEASE_HEADER = 'x-artipod-lease';

/** V10: default lease TTL cap — bounds an open session, never a revocation. */
export const DEFAULT_KEY_TTL_MS = 3_600_000;

export interface KeysHandlerOptions {
  authority: Authority;
  /** Pods this serve brokers (login default scope and hard boundary). */
  podIds: string[];
  /** Issued TTL = min(client-requested, this). Default 1h (V10). */
  capTtlMs?: number;
  /** The S5 auth hook — identity access clamps lease permissions (ro → no write). */
  auth?: AuthHook;
}

interface LoginBody {
  principal?: string;
  podIds?: string[];
  ttlMs?: number;
}

/**
 * PathHandler for `/api/keys` (segments after that prefix):
 *
 *   GET  <base>/            → { authority, publicKey, podIds, capTtlMs }  (metadata only, never keys)
 *   POST <base>/login {principal?, podIds?, ttlMs?} → WireLoginResult
 */
export function createKeysHandler(options: KeysHandlerOptions): PathHandler {
  const { authority, podIds, auth } = options;
  const capTtlMs = options.capTtlMs ?? DEFAULT_KEY_TTL_MS;
  return async (req, path) => {
    const method = req.method.toUpperCase();

    if (path.length === 0 && (method === 'GET' || method === 'HEAD')) {
      const denied = await authorizeAccess(req, auth, 'ro');
      if (denied) return denied;
      return json({ authority: authority.name, publicKey: authority.publicKey, podIds, capTtlMs });
    }

    if (path.length === 1 && path[0] === 'login' && method === 'POST') {
      // Login itself needs only read access — the lease it issues is clamped
      // to the identity's level (an ro token can never lease 'write').
      const denied = await authorizeAccess(req, auth, 'ro');
      if (denied) return denied;
      let access: 'ro' | 'rw' = 'rw';
      let identityName: string | undefined;
      if (auth) {
        const result = await auth(req);
        if (typeof result === 'object') {
          access = result.access;
          identityName = result.name;
        }
      }
      let body: LoginBody = {};
      try {
        const text = await req.text();
        if (text) body = JSON.parse(text) as LoginBody;
      } catch {
        return json({ error: 'invalid JSON body' }, 400);
      }
      const requested = body.podIds ?? podIds;
      const outside = requested.filter((id) => !podIds.includes(id));
      if (outside.length > 0) {
        return json({ error: `not brokered here: ${outside.join(', ')}` }, 403);
      }
      const ttlMs = Math.min(Math.max(1, body.ttlMs ?? capTtlMs), capTtlMs);
      const permissions = access === 'ro' ? ['mount', 'read'] : ['mount', 'read', 'write'];
      const result = await authority.login({
        principal: body.principal ?? identityName ?? 'anonymous',
        podIds: requested,
        ttlMs,
        permissions,
      });
      return json(encodeLoginResult(result), 200);
    }

    return json({ error: 'usage: GET <base>/ | POST <base>/login' }, path.length === 0 || path[0] === 'login' ? 405 : 404);
  };
}

export interface LeaseGateOptions {
  /** The authority's root verify key (base64 SPKI). */
  publicKey: string;
  /** Pods the gated store holds — a lease must cover all of them. */
  podIds: string[];
  clock?: () => number;
}

/**
 * Broker-mode gate for the pods surface (S5.5): blob reads/writes and ref
 * WRITES require a live, signature-verified lease covering the store's pods
 * with a permission matching the method. Ref READS stay open — pointers are
 * the same metadata a blind host serves. Returns null to pass, or the 401/403.
 */
export function requireLease(options: LeaseGateOptions): (req: Request, path: string[]) => Promise<Response | null> {
  const clock = options.clock ?? Date.now;
  return async (req, path) => {
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') return null;
    const isRead = method === 'GET' || method === 'HEAD';
    if (path[0] === 'refs' && isRead) return null;
    const header = req.headers.get(LEASE_HEADER);
    if (!header) {
      return json(
        { error: 'key lease required', hint: `POST /api/keys/login, then send ${LEASE_HEADER}: <base64 lease JSON>` },
        401,
      );
    }
    let lease: Lease;
    try {
      lease = JSON.parse(new TextDecoder().decode(fromBase64(header))) as Lease;
    } catch {
      return json({ error: `malformed ${LEASE_HEADER} header (want base64-encoded lease JSON)` }, 401);
    }
    try {
      await verifyLease(lease, options.publicKey, clock());
    } catch (e) {
      return json({ error: `lease rejected: ${(e as Error).message}`, hint: 're-login at /api/keys/login' }, 401);
    }
    const need = isRead ? 'read' : 'write';
    if (!lease.permissions.includes(need)) {
      return json({ error: `lease lacks '${need}' permission` }, 403);
    }
    const uncovered = options.podIds.filter((id) => !lease.podIds.includes(id));
    if (uncovered.length > 0) {
      return json({ error: `lease does not cover pod ${uncovered.join(', ')}` }, 403);
    }
    return null;
  };
}
