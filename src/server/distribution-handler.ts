/**
 * OCI Distribution API over a PodStore (serve plan S3 read + S4 write, V2).
 * The storage is already the registry's native format (OciLayoutPodStore
 * is an OCI image layout), so this is a thin projection:
 *
 *   pod-store ref "<name>:<tag>"  ⻆  /v2/<name>/manifests/<tag>
 *
 * `<name>` may contain `/`. Read: /v2/ ping, manifests HEAD/GET (tag +
 * digest, Docker-Content-Digest, media-type passthrough — manifest lists
 * included), blobs HEAD/GET (open-ended Range), tags/list and _catalog
 * (n/last pagination + Link header), OCI error envelopes. Write: upload
 * sessions (POST/PATCH/PUT with temp-file accumulation — layers can be
 * GB), the monolithic POST+PUT path, cross-repo mount (trivial 201 — one
 * store), and manifest PUT that verifies every referenced blob first.
 * Ref semantics on /v2 PUT are last-write-wins OVERWRITE (V8) —
 * registries don't merge; the native /api/pods surface keeps mergeHeads.
 * Upload sessions are in-memory + a temp dir: a restart drops them, which
 * the spec permits (clients re-POST).
 */

import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Digest } from '../oci/digest.js';
import type { PodStore } from '../manager/pod-store.js';
import { authorizeAccess, type AuthHook, type PathHandler } from './common.js';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const NAME_RE = /^[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*$/;
const TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
const OCTET_STREAM = 'application/octet-stream';
const DEFAULT_MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';
const INDEX_TYPE = 'application/vnd.oci.image.index.v1+json';

/** OCI error envelope. */
function ociError(status: number, code: string, message: string): Response {
  return Response.json(
    { errors: [{ code, message, detail: {} }] },
    { status, headers: { 'docker-distribution-api-version': 'registry/2.0' } },
  );
}

export interface DistributionHandlerOptions {
  store: PodStore;
  auth?: AuthHook;
  /** Reject pushes (S5 wires ro tokens here); reads stay open to `auth`. */
  readonly?: boolean;
  /** Upload-session TTL; default 1h. Restart-lossy by design (spec-permitted). */
  uploadTtlMs?: number;
}

interface UploadSession {
  name: string;
  file: string;
  size: number;
  lastUsed: number;
}

interface ReferrerDescriptor {
  mediaType: string;
  digest: Digest;
  size: number;
  artifactType?: string;
  annotations?: Record<string, string>;
}

/** Split `<name…>/<kind>/<arg>` where kind ∈ manifests|blobs|referrers, `<name…>/tags/list`, or uploads. */
export function splitRepoPath(
  segments: string[],
): { name: string; kind: 'manifests' | 'blobs' | 'tags' | 'uploads' | 'referrers'; arg: string } | null {
  // <name…>/blobs/uploads[/<uuid>]
  const uploadsIdx = segments.lastIndexOf('uploads');
  if (uploadsIdx >= 2 && segments[uploadsIdx - 1] === 'blobs' && uploadsIdx >= segments.length - 2) {
    const name = segments.slice(0, uploadsIdx - 1).join('/');
    if (!NAME_RE.test(name)) return null;
    return { name, kind: 'uploads', arg: segments[uploadsIdx + 1] ?? '' };
  }
  if (segments.length < 3) return null;
  const arg = segments[segments.length - 1];
  const kind = segments[segments.length - 2];
  const name = segments.slice(0, -2).join('/');
  if (!NAME_RE.test(name)) return null;
  if (kind === 'manifests' || kind === 'blobs') return { name, kind, arg };
  if (kind === 'referrers') return { name, kind, arg };
  if (kind === 'tags' && arg === 'list') return { name, kind, arg };
  return null;
}

/** `<name>:<tag>` — the pod-store spelling of a distribution tag. */
export const distRef = (name: string, tag: string): string => `${name}:${tag}`;

/** Reverse of distRef: last `:` splits (names may contain `/` but never `:`). */
export function parseDistRef(ref: string): { name: string; tag: string } | null {
  const idx = ref.lastIndexOf(':');
  if (idx <= 0) return null;
  const name = ref.slice(0, idx);
  const tag = ref.slice(idx + 1);
  if (!NAME_RE.test(name) || !TAG_RE.test(tag)) return null;
  return { name, tag };
}

function paginate<T extends string>(items: T[], url: URL, listPath: string): { page: T[]; link?: string } {
  const sorted = [...items].sort();
  const last = url.searchParams.get('last');
  const nRaw = url.searchParams.get('n');
  const start = last ? sorted.findIndex((i) => i > last) : 0;
  const from = start < 0 ? sorted.length : start;
  const n = nRaw !== null ? Math.max(0, Number(nRaw) || 0) : sorted.length;
  const page = sorted.slice(from, from + n);
  const hasMore = from + n < sorted.length && page.length > 0;
  const link = hasMore
    ? `<${listPath}?n=${n}&last=${encodeURIComponent(page[page.length - 1])}>; rel="next"`
    : undefined;
  return { page, link };
}

export function createDistributionHandler(options: DistributionHandlerOptions): PathHandler {
  const { store } = options;
  const uploadTtlMs = options.uploadTtlMs ?? 60 * 60_000;
  const sessions = new Map<string, UploadSession>();
  // subject digest → referrer descriptors (in-memory: a restart forgets
  // referrers, like upload sessions — clients using the fallback-tag scheme
  // are unaffected; a persistent index is future work)
  const referrers = new Map<string, ReferrerDescriptor[]>();
  let uploadDirPromise: Promise<string> | null = null;
  const uploadDir = (): Promise<string> => (uploadDirPromise ??= mkdtemp(join(tmpdir(), 'artipod-uploads-')));

  const evictExpired = async (): Promise<void> => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastUsed > uploadTtlMs) {
        sessions.delete(id);
        await rm(s.file, { force: true });
      }
    }
  };

  const appendBody = async (session: UploadSession, req: Request): Promise<void> => {
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) return;
    await appendFile(session.file, bytes);
    session.size += bytes.length;
  };

  const completeUpload = async (session: UploadSession, digest: string): Promise<Response> => {
    if (!DIGEST_RE.test(digest)) return ociError(400, 'DIGEST_INVALID', `invalid digest ${digest}`);
    const bytes = new Uint8Array(await readFile(session.file));
    try {
      await store.putBlob(bytes, digest as Digest);
    } catch (e) {
      return ociError(400, 'DIGEST_INVALID', (e as Error).message);
    } finally {
      await rm(session.file, { force: true });
    }
    return new Response(null, {
      status: 201,
      headers: { location: `/v2/${session.name}/blobs/${digest}`, 'docker-content-digest': digest },
    });
  };

  const newSession = async (name: string): Promise<{ id: string; session: UploadSession }> => {
    const id = randomUUID();
    const session: UploadSession = { name, file: join(await uploadDir(), id), size: 0, lastUsed: Date.now() };
    await writeFile(session.file, new Uint8Array());
    sessions.set(id, session);
    return { id, session };
  };

  const resolveManifest = async (
    name: string,
    arg: string,
  ): Promise<{ digest: Digest; mediaType: string } | null> => {
    if (DIGEST_RE.test(arg)) {
      if (!(await store.hasBlob(arg as Digest))) return null;
      return { digest: arg as Digest, mediaType: DEFAULT_MANIFEST_TYPE };
    }
    if (!TAG_RE.test(arg)) return null;
    const ref = await store.getRef(distRef(name, arg));
    if (!ref) return null;
    return { digest: ref.manifestDigest, mediaType: ref.mediaType || DEFAULT_MANIFEST_TYPE };
  };

  return async (req, path) => {
    const method = req.method.toUpperCase();
    const denied = await authorizeAccess(req, options.auth, method === 'GET' || method === 'HEAD' ? 'ro' : 'rw');
    if (denied) return denied;
    const url = new URL(req.url);

    // GET /v2/ — the ping
    if (path.length === 0) {
      if (method !== 'GET' && method !== 'HEAD') return ociError(405, 'UNSUPPORTED', 'method not allowed');
      return new Response('{}', {
        headers: {
          'content-type': 'application/json',
          'docker-distribution-api-version': 'registry/2.0',
        },
      });
    }

    // GET /v2/_catalog
    if (path.length === 1 && path[0] === '_catalog') {
      if (method !== 'GET') return ociError(405, 'UNSUPPORTED', 'method not allowed');
      const names = new Set<string>();
      for (const r of await store.listRefs()) {
        const parsed = parseDistRef(r.ref);
        if (parsed) names.add(parsed.name);
      }
      const { page, link } = paginate([...names], url, '/v2/_catalog');
      return Response.json(
        { repositories: page },
        { headers: link ? { link } : undefined },
      );
    }

    const repo = splitRepoPath(path);
    if (!repo) return ociError(404, 'NAME_UNKNOWN', 'unknown repository path');

    // Blob upload sessions (S4)
    if (repo.kind === 'uploads') {
      if (options.readonly) return ociError(403, 'DENIED', 'push is disabled (read-only)');
      await evictExpired();
      if (method === 'POST' && repo.arg === '') {
        // Cross-repo mount: same store, so an existing blob is a free 201.
        const mount = url.searchParams.get('mount');
        if (mount && DIGEST_RE.test(mount) && (await store.hasBlob(mount as Digest))) {
          return new Response(null, {
            status: 201,
            headers: { location: `/v2/${repo.name}/blobs/${mount}`, 'docker-content-digest': mount },
          });
        }
        const { id, session } = await newSession(repo.name);
        const digest = url.searchParams.get('digest');
        if (digest) {
          // monolithic POST (crane's happy path)
          await appendBody(session, req);
          const done = await completeUpload(session, digest);
          sessions.delete(id);
          return done;
        }
        return new Response(null, {
          status: 202,
          headers: {
            location: `/v2/${repo.name}/blobs/uploads/${id}`,
            range: '0-0',
            'docker-upload-uuid': id,
          },
        });
      }
      const session = sessions.get(repo.arg);
      if (!session) return ociError(404, 'BLOB_UPLOAD_UNKNOWN', `upload session ${repo.arg} not found`);
      session.lastUsed = Date.now();
      if (method === 'PATCH') {
        // Out-of-order chunks are 416 per spec — Content-Range start must be the current offset.
        const cr = req.headers.get('content-range');
        if (cr) {
          const m = /^(?:bytes[ =])?(\d+)-(\d+)/.exec(cr);
          if (!m || Number(m[1]) !== session.size) {
            return ociError(416, 'BLOB_UPLOAD_INVALID', `chunk range ${cr} does not continue offset ${session.size}`);
          }
        }
        await appendBody(session, req);
        return new Response(null, {
          status: 202,
          headers: {
            location: `/v2/${repo.name}/blobs/uploads/${repo.arg}`,
            range: `0-${Math.max(0, session.size - 1)}`,
            'docker-upload-uuid': repo.arg,
          },
        });
      }
      if (method === 'PUT') {
        const digest = url.searchParams.get('digest');
        if (!digest) return ociError(400, 'DIGEST_INVALID', 'digest query parameter required');
        // A final chunk carrying Content-Range must continue the offset too.
        const cr = req.headers.get('content-range');
        if (cr) {
          const m = /^(?:bytes[ =])?(\d+)-(\d+)/.exec(cr);
          if (!m || Number(m[1]) !== session.size) {
            return ociError(416, 'BLOB_UPLOAD_INVALID', `chunk range ${cr} does not continue offset ${session.size}`);
          }
        }
        await appendBody(session, req);
        const done = await completeUpload(session, digest);
        sessions.delete(repo.arg);
        return done;
      }
      if (method === 'GET') {
        // upload status probe
        return new Response(null, {
          status: 204,
          headers: { range: `0-${Math.max(0, session.size - 1)}`, 'docker-upload-uuid': repo.arg },
        });
      }
      return ociError(405, 'UNSUPPORTED', 'method not allowed');
    }

    // GET /v2/<name>/tags/list
    if (repo.kind === 'tags') {
      if (method !== 'GET') return ociError(405, 'UNSUPPORTED', 'method not allowed');
      const tags: string[] = [];
      for (const r of await store.listRefs()) {
        const parsed = parseDistRef(r.ref);
        if (parsed && parsed.name === repo.name) tags.push(parsed.tag);
      }
      if (tags.length === 0) return ociError(404, 'NAME_UNKNOWN', `repository ${repo.name} not known`);
      const { page, link } = paginate(tags, url, `/v2/${repo.name}/tags/list`);
      return Response.json(
        { name: repo.name, tags: page },
        { headers: link ? { link } : undefined },
      );
    }

    // GET /v2/<name>/referrers/<digest> — OCI referrers API (in-memory index)
    if (repo.kind === 'referrers') {
      if (method !== 'GET') return ociError(405, 'UNSUPPORTED', 'method not allowed');
      if (!DIGEST_RE.test(repo.arg)) return ociError(400, 'DIGEST_INVALID', `invalid digest ${repo.arg}`);
      const all = referrers.get(repo.arg) ?? [];
      const filter = url.searchParams.get('artifactType');
      const manifests = filter ? all.filter((d) => d.artifactType === filter) : all;
      return Response.json(
        { schemaVersion: 2, mediaType: INDEX_TYPE, manifests },
        {
          headers: {
            'content-type': INDEX_TYPE,
            ...(filter ? { 'oci-filters-applied': 'artifactType' } : {}),
          },
        },
      );
    }

    // HEAD|GET|PUT /v2/<name>/manifests/<tag|digest>
    if (repo.kind === 'manifests') {
      if (method === 'PUT') {
        if (options.readonly) return ociError(403, 'DENIED', 'push is disabled (read-only)');
        const bytes = new Uint8Array(await req.arrayBuffer());
        let parsed: {
          mediaType?: string;
          artifactType?: string;
          annotations?: Record<string, string>;
          subject?: { digest?: string };
          config?: { digest?: string; mediaType?: string };
          layers?: { digest?: string; mediaType?: string; urls?: string[] }[];
          manifests?: { digest?: string }[];
        };
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes)) as typeof parsed;
        } catch {
          return ociError(400, 'MANIFEST_INVALID', 'manifest is not valid JSON');
        }
        // Every referenced blob must exist before the manifest lands — except
        // non-distributable/external layers (foreign blobs by design) and the
        // subject (referrers land before or after their subject, both legal).
        const distributable = (parsed.layers ?? []).filter(
          (l) => !(l.mediaType ?? '').includes('nondistributable') && !(l.urls && l.urls.length > 0),
        );
        const referenced = [
          ...(parsed.config?.digest ? [parsed.config.digest] : []),
          ...distributable.map((l) => l.digest),
          ...(parsed.manifests ?? []).map((m) => m.digest),
        ];
        for (const d of referenced) {
          if (!d || !DIGEST_RE.test(d)) return ociError(400, 'MANIFEST_INVALID', `invalid referenced digest ${d}`);
          if (!(await store.hasBlob(d as Digest))) {
            return ociError(400, 'MANIFEST_BLOB_UNKNOWN', `referenced blob ${d} not found`);
          }
        }
        const digest = await store.putBlob(bytes);
        if (DIGEST_RE.test(repo.arg)) {
          if (repo.arg !== digest) return ociError(400, 'DIGEST_INVALID', 'manifest digest mismatch');
        } else {
          if (!TAG_RE.test(repo.arg)) return ociError(400, 'TAG_INVALID', `invalid tag ${repo.arg}`);
          const mediaType = req.headers.get('content-type') || DEFAULT_MANIFEST_TYPE;
          // V8: /v2 tag writes are last-write-wins OVERWRITE — registries don't merge.
          await store.putRef(distRef(repo.name, repo.arg), digest, mediaType);
        }
        const headers: Record<string, string> = {
          location: `/v2/${repo.name}/manifests/${digest}`,
          'docker-content-digest': digest,
        };
        if (parsed.subject?.digest && DIGEST_RE.test(parsed.subject.digest)) {
          headers['oci-subject'] = parsed.subject.digest;
          const list = referrers.get(parsed.subject.digest) ?? [];
          if (!list.some((d) => d.digest === digest)) {
            list.push({
              mediaType: parsed.mediaType ?? req.headers.get('content-type') ?? DEFAULT_MANIFEST_TYPE,
              digest,
              size: bytes.length,
              ...(parsed.artifactType ?? parsed.config?.mediaType
                ? { artifactType: parsed.artifactType ?? parsed.config?.mediaType }
                : {}),
              ...(parsed.annotations ? { annotations: parsed.annotations } : {}),
            });
            referrers.set(parsed.subject.digest, list);
          }
        }
        return new Response(null, { status: 201, headers });
      }
      if (method !== 'GET' && method !== 'HEAD') return ociError(405, 'UNSUPPORTED', 'method not allowed');
      const found = await resolveManifest(repo.name, repo.arg);
      if (!found) return ociError(404, 'MANIFEST_UNKNOWN', `manifest ${repo.name}:${repo.arg} not found`);
      let bytes: Uint8Array;
      try {
        bytes = await store.getBlob(found.digest);
      } catch {
        return ociError(404, 'MANIFEST_UNKNOWN', `manifest blob ${found.digest} missing`);
      }
      // Media type: trust the manifest's own declaration over the ref record.
      let mediaType = found.mediaType;
      try {
        const declared = (JSON.parse(new TextDecoder().decode(bytes)) as { mediaType?: string }).mediaType;
        if (declared) mediaType = declared;
      } catch {
        // non-JSON manifest bytes — serve with the recorded type
      }
      const headers = {
        'content-type': mediaType,
        'content-length': String(bytes.length),
        'docker-content-digest': found.digest,
        'docker-distribution-api-version': 'registry/2.0',
      };
      if (method === 'HEAD') return new Response(null, { headers });
      return new Response(bytes as BodyInit, { headers });
    }

    // HEAD|GET /v2/<name>/blobs/<digest>
    if (method !== 'GET' && method !== 'HEAD') return ociError(405, 'UNSUPPORTED', 'method not allowed');
    if (!DIGEST_RE.test(repo.arg)) return ociError(400, 'DIGEST_INVALID', `invalid digest ${repo.arg}`);
    const digest = repo.arg as Digest;
    if (method === 'HEAD') {
      if (!(await store.hasBlob(digest))) return ociError(404, 'BLOB_UNKNOWN', `blob ${digest} not found`);
      // conformance requires Content-Length on HEAD — size needs the bytes
      let size: number;
      try {
        size = (await store.getBlob(digest)).length;
      } catch {
        return ociError(404, 'BLOB_UNKNOWN', `blob ${digest} not found`);
      }
      return new Response(null, {
        headers: {
          'content-type': OCTET_STREAM,
          'content-length': String(size),
          'docker-content-digest': digest,
        },
      });
    }
    let bytes: Uint8Array;
    try {
      bytes = await store.getBlob(digest);
    } catch {
      return ociError(404, 'BLOB_UNKNOWN', `blob ${digest} not found`);
    }
    const rangeHeader = req.headers.get('range');
    if (rangeHeader) {
      // bytes=A-, bytes=A-B, bytes=-N — anything unsatisfiable is 416
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      let start = -1;
      let end = -1;
      if (m && (m[1] !== '' || m[2] !== '')) {
        if (m[1] === '') {
          // suffix: last N bytes
          const n = Number(m[2]);
          start = Math.max(0, bytes.length - n);
          end = bytes.length - 1;
        } else {
          start = Number(m[1]);
          end = m[2] === '' ? bytes.length - 1 : Math.min(Number(m[2]), bytes.length - 1);
        }
      }
      if (start < 0 || start >= bytes.length || end < start) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
      }
      const body = bytes.subarray(start, end + 1);
      return new Response(body as BodyInit, {
        status: 206,
        headers: {
          'content-type': OCTET_STREAM,
          'content-length': String(body.length),
          'docker-content-digest': digest,
          'content-range': `bytes ${start}-${end}/${bytes.length}`,
        },
      });
    }
    return new Response(bytes as BodyInit, {
      headers: {
        'content-type': OCTET_STREAM,
        'content-length': String(bytes.length),
        'docker-content-digest': digest,
        'accept-ranges': 'bytes',
      },
    });
  };
}
