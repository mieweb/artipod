/**
 * OCI Distribution API over a PodStore — read side (serve plan S3, V2).
 * The storage is already the registry's native format (OciLayoutPodStore
 * is an OCI image layout), so this is a thin projection:
 *
 *   pod-store ref "<name>:<tag>"  ⇄  /v2/<name>/manifests/<tag>
 *
 * `<name>` may contain `/`. Implements: /v2/ ping, manifests HEAD/GET
 * (tag + digest, Docker-Content-Digest, media-type passthrough — manifest
 * lists included), blobs HEAD/GET (open-ended Range), tags/list and
 * _catalog (n/last pagination + Link header), and the OCI error-JSON
 * envelope on every failure. Write side (push) arrives in S4.
 */

import type { Digest } from '../oci/digest.js';
import type { PodStore } from '../manager/pod-store.js';
import { authorize, type AuthHook, type PathHandler } from './common.js';

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const NAME_RE = /^[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*$/;
const TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
const OCTET_STREAM = 'application/octet-stream';
const DEFAULT_MANIFEST_TYPE = 'application/vnd.oci.image.manifest.v1+json';

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
}

/** Split `<name…>/<kind>/<arg>` where kind ∈ manifests|blobs, or `<name…>/tags/list`. */
export function splitRepoPath(
  segments: string[],
): { name: string; kind: 'manifests' | 'blobs' | 'tags'; arg: string } | null {
  if (segments.length < 3) return null;
  const arg = segments[segments.length - 1];
  const kind = segments[segments.length - 2];
  const name = segments.slice(0, -2).join('/');
  if (!NAME_RE.test(name)) return null;
  if (kind === 'manifests' || kind === 'blobs') return { name, kind, arg };
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
    const denied = await authorize(req, options.auth);
    if (denied) return denied;
    const method = req.method.toUpperCase();
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

    // HEAD|GET /v2/<name>/manifests/<tag|digest>
    if (repo.kind === 'manifests') {
      if (method !== 'GET' && method !== 'HEAD') return ociError(405, 'UNSUPPORTED', 'method not allowed (push arrives in serve plan S4)');
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
    if (method !== 'GET' && method !== 'HEAD') return ociError(405, 'UNSUPPORTED', 'method not allowed (push arrives in serve plan S4)');
    if (!DIGEST_RE.test(repo.arg)) return ociError(400, 'DIGEST_INVALID', `invalid digest ${repo.arg}`);
    const digest = repo.arg as Digest;
    if (method === 'HEAD') {
      if (!(await store.hasBlob(digest))) return ociError(404, 'BLOB_UNKNOWN', `blob ${digest} not found`);
      return new Response(null, {
        headers: { 'content-type': OCTET_STREAM, 'docker-content-digest': digest },
      });
    }
    let bytes: Uint8Array;
    try {
      bytes = await store.getBlob(digest);
    } catch {
      return ociError(404, 'BLOB_UNKNOWN', `blob ${digest} not found`);
    }
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
          'docker-content-digest': digest,
          'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
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
