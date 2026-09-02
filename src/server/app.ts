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
import { json, type AuthHook, type PathHandler } from './common.js';
import { createPodStoreHandler, type PodStoreHandlerOptions } from './pod-store-handler.js';
import { createRegistryRelayHandler } from './registry-relay.js';
import { createGitProxyHandler } from './git-proxy.js';
import { createExecSessionHandler, type ExecSessionHandlerOptions } from './exec-handler.js';
import { createDistributionHandler } from './distribution-handler.js';
import { withCors } from './cors.js';

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
  /**
   * Handles anything outside /api and /v2 — the static UI (S2) or the
   * headless landing page (S1). Absent = 404 JSON.
   */
  fallback?: (req: Request) => Response | Promise<Response>;
}

export type ArtipodApp = (req: Request) => Promise<Response>;

export function createArtipodApp(options: ArtipodAppOptions): ArtipodApp {
  const web = options.surfaces?.web ?? true;
  const registry = options.surfaces?.registry ?? true;
  const cors = options.cors ?? [];
  const pods: PathHandler | null = web
    ? withCors(
        createPodStoreHandler({
          store: options.store,
          auth: options.auth,
          onRefPut: options.onRefPut,
          merge: options.merge,
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
  const dist: PathHandler | null = registry
    ? withCors(createDistributionHandler({ store: options.store, auth: options.auth }), cors)
    : null;

  return async (req) => {
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const [first, second, ...rest] = segments;
    if (first === 'v2' && dist) return dist(req, [...(second === undefined ? [] : [second]), ...rest]);
    if (first === 'api') {
      if (second === 'pods' && pods) return pods(req, rest);
      if (second === 'oci' && relay) return relay(req, rest);
      if (second === 'git' && git) return git(req, rest);
      if (second === 'exec' && exec && rest.length === 0) return exec(req);
      return json({ error: 'not found' }, 404);
    }
    if (first !== 'v2' && options.fallback) return options.fallback(req);
    return json({ error: 'not found' }, 404);
  };
}
