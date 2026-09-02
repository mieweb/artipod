/**
 * ref → published-folder mapping (serve plan S1; ported from artipod-sync's
 * lib/publish-map.ts, parameterized — no env singletons). The map records
 * where a ref came from so the pods handler's onRefPut can materialize
 * pushed heads back into that folder. It lives beside the store so it
 * survives restarts; the roots allowlist check re-runs on EVERY
 * materialize — the map is data, not authority.
 */

import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import path, { dirname } from 'node:path';

/** Resolve symlinks, then require the target to sit under an allowed root. Empty roots = deny all. */
export async function withinRoots(dir: string, roots: Iterable<string>): Promise<string | null> {
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

/** JSON-file-backed ref → folder map. */
export class PublishMap {
  constructor(private readonly file: string) {}

  private async read(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async record(ref: string, dir: string): Promise<void> {
    const map = await this.read();
    map[ref] = dir;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(map, null, 2));
  }

  async dirFor(ref: string): Promise<string | null> {
    return (await this.read())[ref] ?? null;
  }

  async entries(): Promise<Record<string, string>> {
    return this.read();
  }
}
