/**
 * POST /api/pods/publish records where a ref came from; pushed heads
 * materialize back into that folder (lib/artipod-app.ts onRefPut). The
 * engine is core's PublishMap/withinRoots (dry plan E3 — the fork this
 * file used to be is deleted); only env parsing lives app-side.
 */
import { join } from 'node:path';
import { PublishMap } from '@artipod/core/server';

export const publishRoots = (): string[] =>
  (process.env.ARTIPOD_PUBLISH_ROOTS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

let map: PublishMap | null = null;

export function getPublishMap(): PublishMap {
  if (!map) {
    map = new PublishMap(join(process.env.ARTIPOD_STORE_DIR ?? '.artipod-store', 'publish-map.json'));
  }
  return map;
}
