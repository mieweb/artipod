/**
 * createArtipodApp — the one Fetch handler behind `artipod serve` and every
 * embedder (serve plan S0, §3.1). Composes the existing handler factories
 * behind surface flags:
 *
 *   /api/pods/*   → createPodStoreHandler   (web surface)
 *   /api/oci/*    → createRegistryRelayHandler (web surface)
 *   /api/git/*    → createGitProxyHandler   (web surface)
 *   /api/exec     → createExecSessionHandler (web surface, opt-in)
 *   /v2/*         → distribution handler (registry surface — arrives S3)
 *
 * The returned function is WinterCG-shaped: it mounts unmodified in a
 * Next.js catch-all route, Hono, Bun.serve, Deno.serve, or the node
 * adapter (`serveApp`). The CLI and an embedder's app run the same object.
 */

import type { PodStore } from '../manager/pod-store.js';
import type { Authority } from '../manager/authority.js';
import { authorizeAccess, json, type AuthHook, type PathHandler } from './common.js';
import { createPodStoreHandler, type PodStoreHandlerOptions } from './pod-store-handler.js';
import { createRegistryRelayHandler } from './registry-relay.js';
import { createGitProxyHandler } from './git-proxy.js';
import { createExecSessionHandler, type ExecSessionHandlerOptions } from './exec-handler.js';
import { createDistributionHandler } from './distribution-handler.js';
import { createKeysHandler, requireLease } from './keys-handler.js';
import { withCors } from './cors.js';
import { createStaticHandler } from './static.js';

export interface ArtipodAppOptions {
  /** The one stateful thing. */
  store: PodStore;
  /** Default: both surfaces on. */
  surfaces?: { web?: boolean; registry?: boolean };
  /** Absent = open (auth is the deployment's policy — serve plan S5 grows identities). */
  auth?: AuthHook;
  /** Allowed origins for pods//v2/relay responses; default [] = deny. */
  cors?: string[];
  /** Upstream registry relay policy; default deny-all. */
  relay?: { allowedHosts: Iterable<string> };
  /** git smart-HTTP proxy allowlist; default env-driven (GIT_PROXY_ALLOWED_HOSTS). */
  gitAllowlist?: string[];
  /** Exec session surface; false/absent = off (it is arbitrary compute). */
  exec?: ExecSessionHandlerOptions | false;
  onRefPut?: PodStoreHandlerOptions['onRefPut'];
  merge?: PodStoreHandlerOptions['merge'];
  /** Tag immutability (both surfaces): a locked ref rejects head moves with 403. */
  isLocked?: PodStoreHandlerOptions['isLocked'];
  /** Ref operations journal (both surfaces): every head move/delete, before→after. */
  onRefOp?: PodStoreHandlerOptions['onRefOp'];
  /** Static UI dir (node-only) served for anything outside /api and /v2. */
  ui?: { dir: string } | false;
  /**
   * Key-broker surface (S5.5, V9): mounts `/api/keys` (login → signed lease
   * + KEKs) over the given authority. `enforce` (default true) additionally
   * gates the pods surface — blob reads/writes and ref writes need a live
   * lease covering `podIds` — and disables `/v2` (the distribution API
   * cannot carry leases). Absent = `/api/keys` 404s, nothing is gated.
   */
  keys?: {
    authority: Authority;
    podIds: string[];
    capTtlMs?: number;
    enforce?: boolean;
    clock?: () => number;
  };
  /**
   * Handles anything outside /api and /v2 when no `ui` dir is configured —
   * the headless landing page (S1). Absent = 404 JSON.
   */
  fallback?: (req: Request) => Response | Promise<Response>;
}

export type ArtipodApp = (req: Request) => Promise<Response>;

export function createArtipodApp(options: ArtipodAppOptions): ArtipodApp {
  const web = options.surfaces?.web ?? true;
  const registry = options.surfaces?.registry ?? true;
  const cors = options.cors ?? [];
  const leaseGate =
    options.keys && (options.keys.enforce ?? true)
      ? requireLease({ publicKey: options.keys.authority.publicKey, podIds: options.keys.podIds, clock: options.keys.clock })
      : null;
  let podsInner: PathHandler | null = web
    ? createPodStoreHandler({
        store: options.store,
        auth: options.auth,
        onRefPut: options.onRefPut,
        merge: options.merge,
        isLocked: options.isLocked,
        onRefOp: options.onRefOp,
      })
    : null;
  if (podsInner && leaseGate) {
    const inner = podsInner;
    podsInner = async (req, path) => (await leaseGate(req, path)) ?? inner(req, path);
  }
  const pods: PathHandler | null = podsInner ? withCors(podsInner, cors) : null;
  const keys: PathHandler | null =
    web && options.keys
      ? withCors(
          createKeysHandler({
            authority: options.keys.authority,
            podIds: options.keys.podIds,
            capTtlMs: options.keys.capTtlMs,
            auth: options.auth,
          }),
          cors,
        )
      : null;
  const relay: PathHandler | null = web
    ? withCors(createRegistryRelayHandler({ allowedHosts: options.relay?.allowedHosts ?? [] }), cors)
    : null;
  const git: PathHandler | null = web
    ? createGitProxyHandler(options.gitAllowlist ? { allowlist: options.gitAllowlist } : {})
    : null;
  const exec = web && options.exec ? createExecSessionHandler(options.exec) : null;
  const dist: PathHandler | null =
    registry && !leaseGate
      ? withCors(createDistributionHandler({ store: options.store, auth: options.auth, isLocked: options.isLocked, onRefOp: options.onRefOp }), cors)
      : null;
  const ui = options.ui ? createStaticHandler(options.ui.dir) : null;

  return async (req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [first, second, ...rest] = segments;
    const method = req.method.toUpperCase();
    // pods//v2/exec gate through their own hooks; the relay, git proxy, and
    // fallback are gated here so a configured auth covers EVERY surface (V7).
    // OPTIONS preflights carry no credentials and pass to the CORS layer.
    if (options.auth && method !== 'OPTIONS') {
      // pods, keys, and /v2 gate through their own hooks; everything else
      // here (incl. exec — its own auth option is an EXTRA gate when configured)
      const gatedHere = first !== 'v2' && !(first === 'api' && (second === 'pods' || second === 'keys'));
      if (gatedHere) {
        const isGit = first === 'api' && second === 'git';
        // git smart-HTTP POSTs (upload-pack) are reads; everything else keys off the method
        const need = isGit || method === 'GET' || method === 'HEAD' ? 'ro' : 'rw';
        const denied = await authorizeAccess(req, options.auth, need);
        if (denied) return denied;
      }
    }
    if (first === 'v2') {
      if (registry && leaseGate) {
        return json(
          { error: 'encrypted store: the /v2 distribution surface is off (it cannot carry key leases) — use /api/pods with a lease, or serve without --encrypt' },
          403,
        );
      }
      if (dist) return dist(req, [...(second === undefined ? [] : [second]), ...rest]);
    }
    if (first === 'api') {
      if (second === 'pods' && pods) return pods(req, rest);
      if (second === 'keys' && keys) return keys(req, rest);
      if (second === 'oci' && relay) return relay(req, rest);
      if (second === 'git' && git) return git(req, rest);
      if (second === 'exec' && exec && rest.length === 0) return exec(req);
      return json({ error: 'not found' }, 404);
    }
    if (first !== 'v2') {
      if (ui) return ui(req);
      if (options.fallback) return options.fallback(req);
    }
    return json({ error: 'not found' }, 404);
  };
}
