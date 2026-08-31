/**
 * ref → server-folder mapping (sync plan Phase E): POST /api/pods/publish
 * records where a ref came from; the pods route's onRefPut materializes
 * pushed heads back into that folder. Stored beside the store so it
 * survives restarts; the ARTIPOD_PUBLISH_ROOTS check re-runs on every
 * materialize (the map is data, not authority).
 */
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path, { join } from 'node:path';

const mapPath = () => join(process.env.ARTIPOD_STORE_DIR ?? '.artipod-store', 'publish-map.json');

/** Resolve symlinks, then require the target to sit under an allowed root. */
export async function withinPublishRoots(dir: string): Promise<string | null> {
  const roots = (process.env.ARTIPOD_PUBLISH_ROOTS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  let real: string;
  try {
    real = await realpath(path.resolve(dir));
  } catch {
    return null;
  }
  for (const root of roots) {
    try {
      const realRoot = await realpath(path.resolve(root));
      if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
    } catch {
      // unreadable root entries never authorize anything
    }
  }
  return null;
}

async function readMap(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(mapPath(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function recordPublishDir(ref: string, dir: string): Promise<void> {
  const map = await readMap();
  map[ref] = dir;
  await mkdir(join(mapPath(), '..'), { recursive: true });
  await writeFile(mapPath(), JSON.stringify(map, null, 2));
}

export async function publishDirFor(ref: string): Promise<string | null> {
  return (await readMap())[ref] ?? null;
}
