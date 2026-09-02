import { createPodStoreHandler, materializeRef, type PathHandler } from '@artipod/core/server';
import { getPodStore } from '@/lib/pods-store';
import { publishDirFor, withinPublishRoots } from '@/lib/publish-map';

/**
 * /api/pods — this deployment's pod manager sync surface (plan Phase 6,
 * sync plan Phase B): @artipod/core/server's PodStore handler over the OCI
 * image-layout directory store at ARTIPOD_STORE_DIR (Decision #6 —
 * inspectable with skopeo/crane, trivial to back up). Digests verify on
 * both ends; auth/rate policy is this app's concern and intentionally
 * open in the dev demo (pass `auth` to createPodStoreHandler to close it).
 */
export const dynamic = 'force-dynamic';

let handlerPromise: Promise<PathHandler> | null = null;

function getHandler(): Promise<PathHandler> {
  if (!handlerPromise) {
    handlerPromise = getPodStore().then((store) =>
      createPodStoreHandler({
        store,
        // Sync plan Phase E: a pushed head lands in the folder it came from
        // (mapping recorded at publish time; roots re-checked every time).
        onRefPut: async (ref) => {
          const mapped = await publishDirFor(ref);
          const dir = mapped ? await withinPublishRoots(mapped) : null;
          if (!dir) return;
          try {
            const result = await materializeRef(store, ref, dir);
            if (result.warnings.length) console.warn(`materialize ${ref}:`, result.warnings.join('; '));
          } catch (e) {
            // best-effort: the ref landed; the folder catches up on the next push
            console.warn(`materialize ${ref} failed:`, (e as Error).message);
          }
        },
      }),
    );
  }
  return handlerPromise;
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  return (await getHandler())(req, (await params).path ?? []);
}

export async function HEAD(req: Request, { params }: Ctx): Promise<Response> {
  return (await getHandler())(req, (await params).path ?? []);
}

export async function PUT(req: Request, { params }: Ctx): Promise<Response> {
  return (await getHandler())(req, (await params).path ?? []);
}
