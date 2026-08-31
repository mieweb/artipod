/**
 * POST /api/pods/publish — snapshot a SERVER folder into the pod store as
 * an artipod (sync plan Phase C). Body: { dir, ref, group?, actor? }.
 * publishDirectory (per-file layers + published indexes + LWW annotations)
 * lives in @artipod/core/server; THIS deployment's policy is the
 * ARTIPOD_PUBLISH_ROOTS allowlist — empty = publishing disabled.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { publishDirectory } from '@artipod/core/server';
import { getPodStore } from '@/lib/pods-store';

export const dynamic = 'force-dynamic';

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,180}(:[A-Za-z0-9._\-]{1,60})?$/;

/** Resolve symlinks, then require the target to sit under an allowed root. */
async function withinPublishRoots(dir: string): Promise<string | null> {
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

export async function POST(req: Request): Promise<Response> {
  let body: { dir?: unknown; ref?: unknown; group?: unknown; actor?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (typeof body.dir !== 'string' || typeof body.ref !== 'string' || !REF_RE.test(body.ref)) {
    return Response.json({ error: 'dir and ref (name[:tag]) required' }, { status: 400 });
  }
  const dir = await withinPublishRoots(body.dir);
  if (!dir) {
    return Response.json(
      { error: `dir not under ARTIPOD_PUBLISH_ROOTS`, hint: 'the allowlist is empty by default — publishing is opt-in' },
      { status: 403 },
    );
  }

  const store = await getPodStore();
  const result = await publishDirectory(store, dir, body.ref, {
    group: Array.isArray(body.group) ? (body.group as string[]) : undefined,
    actor: typeof body.actor === 'string' ? body.actor : undefined,
  });
  return Response.json(result, { status: result.unchanged ? 200 : 201 });
}
