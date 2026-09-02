/**
 * createPodStoreHandler — a manager's HTTP sync surface over any PodStore
 * (sync plan Phase B; graduated from the artipod-sync /api/pods route).
 * Wire shape matches HttpPodStore:
 *
 *   HEAD/GET <base>/blobs/<digest>          → 200 bytes | 404   (GET honors Range: bytes=N- → 206)
 *   PUT      <base>/blobs/<digest>  body    → 201 (digest-verified — tampered uploads bounce)
 *   GET      <base>/refs[?name=]            → StoredRef[] | StoredRef | 404
 *   PUT      <base>/refs {ref, manifestDigest, mediaType} → 201 (409 until the manifest blob exists)
 *
 * Digests verify on both ends, so the wire never needs trust. Auth and rate
 * policy are the deployment's concern — the `auth` hook is the seam.
 */

import type { Digest } from '../oci/digest.js';
import type { PodStore } from '../manager/pod-store.js';
import { isAncestor, mergeHeads, type MergeOptions } from '../manager/merge.js';
import { authorizeAccess, json, type AuthHook, type PathHandler } from './common.js';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const OCTET_STREAM = 'application/octet-stream';

export interface PodStoreHandlerOptions {
  store: PodStore;
  auth?: AuthHook;
  /** Fires after a successful ref update — the folder-materialize hook (sync plan Phase E). */
  onRefPut?: (ref: string, manifestDigest: Digest) => void | Promise<void>;
  /** Tag immutability: a locked ref rejects every head move with 403 (reads unaffected). */
  isLocked?: (ref: string) => boolean | Promise<boolean>;
  /**
   * Merge-on-push (sync plan Phase F): a pushed head that has diverged from
   * the current one joins via mergeHeads instead of overwriting; a stale
   * push (current already contains it) leaves the head alone. Default ON;
   * pass `false` to overwrite like Phase E, or MergeOptions to add D9
   * content mergers.
   */
  merge?: boolean | MergeOptions;
}

export function createPodStoreHandler(options: PodStoreHandlerOptions): PathHandler {
  const { store, auth, onRefPut, isLocked } = options;
  const mergeOptions: MergeOptions | null = options.merge === false ? null : typeof options.merge === 'object' ? options.merge : {};
  return async (req, path) => {
    const method = req.method.toUpperCase();
    const denied = await authorizeAccess(req, auth, method === 'GET' || method === 'HEAD' ? 'ro' : 'rw');
    if (denied) return denied;
    const [kind, digest] = path;

    if (kind === 'blobs' && digest && DIGEST_RE.test(digest)) {
      if (method === 'HEAD') {
        return new Response(null, { status: (await store.hasBlob(digest as Digest)) ? 200 : 404 });
      }
      if (method === 'GET') {
        let bytes: Uint8Array;
        try {
          bytes = await store.getBlob(digest as Digest);
        } catch {
          return json({ error: 'not found' }, 404);
        }
        // Byte-offset resume (plan 6.6): open-ended suffix ranges only; any
        // other shape falls back to 200-full, which the client handles.
        const match = /^bytes=(\d+)-$/.exec(req.headers.get('range') ?? '');
        if (match) {
          const start = Number(match[1]);
          if (start >= bytes.length) {
            return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
          }
          return new Response(bytes.subarray(start) as BodyInit, {
            status: 206,
            headers: {
              'content-type': OCTET_STREAM,
              'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
            },
          });
        }
        return new Response(bytes as BodyInit, { headers: { 'content-type': OCTET_STREAM } });
      }
      if (method === 'PUT') {
        const bytes = new Uint8Array(await req.arrayBuffer());
        try {
          await store.putBlob(bytes, digest as Digest);
        } catch (e) {
          return json({ error: (e as Error).message }, 400);
        }
        return new Response(null, { status: 201 });
      }
    }

    if (kind === 'refs') {
      if (method === 'GET') {
        const name = new URL(req.url).searchParams.get('name');
        const decorate = async (r: { ref: string }) =>
          (await isLocked?.(r.ref)) ? { ...r, locked: true } : r;
        if (name) {
          const ref = await store.getRef(name);
          return ref ? json(await decorate(ref)) : json({ error: 'not found' }, 404);
        }
        return json(await Promise.all((await store.listRefs()).map(decorate)));
      }
      if (method === 'PUT') {
        let body: { ref?: string; manifestDigest?: string; mediaType?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return json({ error: 'invalid JSON body' }, 400);
        }
        if (!body.ref || !body.manifestDigest || !DIGEST_RE.test(body.manifestDigest)) {
          return json({ error: 'ref and manifestDigest required' }, 400);
        }
        if (!(await store.hasBlob(body.manifestDigest as Digest))) {
          return json({ error: 'push the manifest blob before the ref' }, 409);
        }
        if (await isLocked?.(body.ref)) {
          return json({ error: `ref '${body.ref}' is locked — publish under a new ref instead` }, 403);
        }
        let finalDigest = body.manifestDigest as Digest;
        let merged = false;
        const current = mergeOptions ? await store.getRef(body.ref) : null;
        if (current && current.manifestDigest !== finalDigest && mergeOptions) {
          if (await isAncestor(store, finalDigest, current.manifestDigest)) {
            finalDigest = current.manifestDigest; // stale push — keep the newer head
          } else if (!(await isAncestor(store, current.manifestDigest, finalDigest))) {
            const result = await mergeHeads(store, current.manifestDigest, finalDigest, mergeOptions);
            finalDigest = result.manifestDigest;
            merged = result.kind === 'merged';
          }
          // else: fast-forward — the incoming head wins as-is
        }
        await store.putRef(
          body.ref,
          finalDigest,
          body.mediaType ?? 'application/vnd.oci.image.manifest.v1+json',
        );
        await onRefPut?.(body.ref, finalDigest);
        return json({ manifestDigest: finalDigest, merged }, 201);
      }
    }

    return json({ error: 'usage: <base>/blobs/<digest> | <base>/refs[?name=]' }, 400);
  };
}
