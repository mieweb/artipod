/**
 * POST /api/pods/publish — snapshot a SERVER folder into the pod store as
 * an artipod (sync plan Phase C). Body: { dir, ref, group?, actor? }.
 * publishDirectory (per-file layers + published indexes + LWW annotations)
 * lives in @artipod/core/server; THIS deployment's policy is the
 * ARTIPOD_PUBLISH_ROOTS allowlist — empty = publishing disabled.
 */
import { publishDirectory, withinRoots } from '@artipod/core/server';
import { getPodStore } from '@/lib/pods-store';
import { getPublishMap, publishRoots } from '@/lib/publish-map';

export const dynamic = 'force-dynamic';

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,180}(:[A-Za-z0-9._\-]{1,60})?$/;

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
  const dir = await withinRoots(body.dir, publishRoots());
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
  // Write-back target (sync plan Phase E): pushed heads materialize here.
  await getPublishMap().record(body.ref, dir);
  return Response.json(result, { status: result.unchanged ? 200 : 201 });
}
