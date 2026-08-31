import { nodePodFs } from '@artipod/core';
import { OciLayoutPodStore } from '@artipod/core/manager';
import { createPodStoreHandler, type PathHandler } from '@artipod/core/server';

/**
 * /api/pods — this deployment's pod manager sync surface (plan Phase 6,
 * sync plan Phase B): @artipod/core/server's PodStore handler over the OCI
 * image-layout directory store at ARTIPOD_STORE_DIR (Decision #6 —
 * inspectable with skopeo/crane, trivial to back up). Digests verify on
 * both ends; auth/rate policy is this app's concern and intentionally
 * open in the dev demo (pass `auth` to createPodStoreHandler to close it).
 */
export const dynamic = 'force-dynamic';

const storeDir = process.env.ARTIPOD_STORE_DIR ?? '.artipod-store';
let handlerPromise: Promise<PathHandler> | null = null;

function getHandler(): Promise<PathHandler> {
  if (!handlerPromise) {
    handlerPromise = (async () => {
      const store = new OciLayoutPodStore(nodePodFs(), storeDir);
      await store.init();
      return createPodStoreHandler({ store });
    })();
  }
  return handlerPromise;
}

type Ctx = { params: { path: string[] } };

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  return (await getHandler())(req, params.path ?? []);
}

export async function HEAD(req: Request, { params }: Ctx): Promise<Response> {
  return (await getHandler())(req, params.path ?? []);
}

export async function PUT(req: Request, { params }: Ctx): Promise<Response> {
  return (await getHandler())(req, params.path ?? []);
}
