/**
 * The example's composed artipod app (dry plan E2, spa-ui-plan UE): ONE
 * `createArtipodApp` behind ONE catch-all replaces the four hand-wired
 * routes (/api/pods, /api/oci, /api/git, /api/exec). Same URLs, same
 * behavior — this deployment contributes only its policy: env allowlists,
 * the exec numbers, and the publish write-back glue.
 */
import { PodSessionHost } from '@artipod/core/manager';
import {
  allowedHosts,
  bearerAuth,
  createArtipodApp,
  materializeRef,
  withinRoots,
  type ArtipodApp,
} from '@artipod/core/server';
import { getPodStore } from './pods-store';
import { getPublishMap, publishRoots } from './publish-map';

let appPromise: Promise<ArtipodApp> | null = null;

export function getArtipodApp(): Promise<ArtipodApp> {
  if (!appPromise) {
    appPromise = (async () => {
      const store = await getPodStore();
      return createArtipodApp({
        store,
        relay: { allowedHosts: (process.env.ARTIPOD_OCI_ALLOWED_HOSTS ?? '').split(',') },
        gitAllowlist: allowedHosts(process.env.GIT_PROXY_ALLOWED_HOSTS),
        // Same numbers as the old /api/exec route; EXEC_API_TOKEN closes it.
        exec: {
          host: new PodSessionHost({
            ttlMs: 15 * 60 * 1000,
            maxSessions: 50,
            execTimeoutMs: 30_000,
            maxFsBytes: 256 * 1024 * 1024,
          }),
          auth: bearerAuth(() => process.env.EXEC_API_TOKEN),
        },
        // Next serves the UI; unknown /api/* stays 404 JSON (no fallback).
        ui: false,
        // Sync plan Phase E write-back: a pushed head lands in the folder it
        // was published from. The map is data, not authority — roots re-check
        // on every materialize; failures warn (the ref landed; the folder
        // catches up on the next push).
        onRefPut: async (ref) => {
          const mapped = await getPublishMap().dirFor(ref);
          const dir = mapped ? await withinRoots(mapped, publishRoots()) : null;
          if (!dir) return;
          try {
            const result = await materializeRef(store, ref, dir);
            if (result.warnings.length) console.warn(`materialize ${ref}:`, result.warnings.join('; '));
          } catch (e) {
            console.warn(`materialize ${ref} failed:`, (e as Error).message);
          }
        },
      });
    })();
  }
  return appPromise;
}
