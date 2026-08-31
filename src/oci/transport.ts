/**
 * OCI transports (issue #1 step 5) behind one interface: resolve a ref to a
 * manifest and fetch blobs by digest, with verification at the store
 * boundary (pull.ts). Three implementations:
 *
 *  - DirectRegistryTransport — the OCI distribution protocol, including the
 *    anonymous bearer-token dance (docker.io); browser-usable only where
 *    CORS allows, which is why…
 *  - ArtipodRegistryProxyTransport — the same protocol with every absolute
 *    URL rewritten through the app's `/api/oci/<host>/<path>` relay
 *    (allowlist lives server-side, default deny — plan Decision #4).
 *  - OciLayoutTransport — an OCI image-layout directory in any PodFs-shaped
 *    fs (hostDir mount, zenfs path): local import, no network.
 */

import { sha256, isDigest, digestHex, type Digest } from './digest.js';

export interface ImageRef {
  /** Registry host as the user wrote it ('docker.io', 'ghcr.io', …). */
  host: string;
  /** Repository ('library/alpine'). */
  repo: string;
  tag?: string;
  digest?: Digest;
}

/** docker.io's API actually lives on registry-1.docker.io. */
const REGISTRY_HOST_ALIASES: Record<string, string> = { 'docker.io': 'registry-1.docker.io' };

export function parseImageRef(input: string): ImageRef {
  let rest = input.trim();
  let digest: Digest | undefined;
  const at = rest.indexOf('@');
  if (at !== -1) {
    const d = rest.slice(at + 1);
    if (!isDigest(d)) throw new Error(`Invalid digest in ref: '${input}'`);
    digest = d;
    rest = rest.slice(0, at);
  }
  let tag: string | undefined;
  const colon = rest.lastIndexOf(':');
  if (colon !== -1 && !rest.slice(colon + 1).includes('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const slash = rest.indexOf('/');
  let host = 'docker.io';
  let repo = rest;
  if (slash !== -1 && (rest.slice(0, slash).includes('.') || rest.slice(0, slash) === 'localhost' || rest.slice(0, slash).includes(':'))) {
    host = rest.slice(0, slash);
    repo = rest.slice(slash + 1);
  }
  if (host === 'docker.io' && !repo.includes('/')) repo = `library/${repo}`;
  if (!repo) throw new Error(`Invalid image ref: '${input}'`);
  return { host, repo, tag: digest ? tag : (tag ?? 'latest'), digest };
}

export function formatImageRef(ref: ImageRef): string {
  return `${ref.host}/${ref.repo}${ref.tag ? `:${ref.tag}` : ''}${ref.digest ? `@${ref.digest}` : ''}`;
}

export interface ResolvedManifest {
  manifestDigest: Digest;
  mediaType: string;
  bytes: Uint8Array;
}

export interface OciTransport {
  resolve(ref: ImageRef, opts?: { digest?: Digest }): Promise<ResolvedManifest>;
  fetchBlob(ref: ImageRef, digest: Digest): Promise<Uint8Array>;
}

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export interface DirectRegistryOptions {
  fetchFn?: typeof fetch;
  /** Rewrites every absolute URL (registry AND token service) — the proxy hook. */
  rewriteUrl?: (url: string) => string;
}

export class DirectRegistryTransport implements OciTransport {
  private readonly fetchFn: typeof fetch;
  private readonly rewriteUrl: (url: string) => string;
  private tokens = new Map<string, string>();

  constructor(options: DirectRegistryOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
    this.rewriteUrl = options.rewriteUrl ?? ((u) => u);
  }

  private registryHost(ref: ImageRef): string {
    return REGISTRY_HOST_ALIASES[ref.host] ?? ref.host;
  }

  private async request(ref: ImageRef, url: string, accept?: string): Promise<Response> {
    const doFetch = (token?: string) =>
      this.fetchFn(this.rewriteUrl(url), {
        headers: {
          ...(accept ? { accept } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });

    const cacheKey = `${this.registryHost(ref)}/${ref.repo}`;
    let response = await doFetch(this.tokens.get(cacheKey));
    if (response.status === 401) {
      const challenge = response.headers.get('www-authenticate') ?? '';
      const token = await this.anonymousToken(challenge);
      if (token) {
        this.tokens.set(cacheKey, token);
        response = await doFetch(token);
      }
    }
    if (!response.ok) {
      throw new Error(`Registry request failed (${response.status} ${response.statusText}): ${url}`);
    }
    return response;
  }

  /** Anonymous bearer-token flow: parse the WWW-Authenticate challenge. */
  private async anonymousToken(challenge: string): Promise<string | null> {
    const match = /Bearer\s+(.*)/i.exec(challenge);
    if (!match) return null;
    const params: Record<string, string> = {};
    for (const part of match[1].split(',')) {
      const [k, v] = part.split('=');
      if (k && v) params[k.trim()] = v.trim().replace(/^"|"$/g, '');
    }
    if (!params.realm) return null;
    const url = new URL(params.realm);
    if (params.service) url.searchParams.set('service', params.service);
    if (params.scope) url.searchParams.set('scope', params.scope);
    const response = await this.fetchFn(this.rewriteUrl(url.toString()), {});
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: string; access_token?: string };
    return body.token ?? body.access_token ?? null;
  }

  async resolve(ref: ImageRef, opts?: { digest?: Digest }): Promise<ResolvedManifest> {
    const reference = opts?.digest ?? ref.digest ?? ref.tag ?? 'latest';
    const url = `https://${this.registryHost(ref)}/v2/${ref.repo}/manifests/${reference}`;
    const response = await this.request(ref, url, MANIFEST_ACCEPT);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const manifestDigest = await sha256(bytes);
    if (isDigest(String(reference)) && manifestDigest !== reference) {
      throw new Error(`Manifest digest mismatch: asked ${String(reference)}, got ${manifestDigest}`);
    }
    const mediaType =
      response.headers.get('content-type')?.split(';')[0] ??
      (JSON.parse(new TextDecoder().decode(bytes)) as { mediaType?: string }).mediaType ??
      'application/vnd.oci.image.manifest.v1+json';
    return { manifestDigest, mediaType, bytes };
  }

  async fetchBlob(ref: ImageRef, digest: Digest): Promise<Uint8Array> {
    const url = `https://${this.registryHost(ref)}/v2/${ref.repo}/blobs/${digest}`;
    const response = await this.request(ref, url);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/**
 * The same protocol relayed through the app's `/api/oci` route:
 * `https://<host>/<path>` → `<baseUrl>/<host>/<path>`. The allowlist is
 * enforced server-side at initialization (default deny).
 */
export class ArtipodRegistryProxyTransport extends DirectRegistryTransport {
  constructor(baseUrl = '/api/oci', options: Omit<DirectRegistryOptions, 'rewriteUrl'> = {}) {
    const base = baseUrl.replace(/\/$/, '');
    super({
      ...options,
      rewriteUrl: (url) => {
        const u = new URL(url);
        return `${base}/${u.host}${u.pathname}${u.search}`;
      },
    });
  }
}

/** Minimal fs shape the layout transport needs (PodFs/ZenFsLike-compatible). */
export interface LayoutFsLike {
  readFile(path: string): Promise<Uint8Array>;
  readFileText(path: string): Promise<string>;
}

export interface OciLayoutDescriptor {
  mediaType: string;
  digest: Digest;
  size: number;
  annotations?: Record<string, string>;
}

/** An OCI image-layout directory (skopeo/crane compatible) as a transport. */
export class OciLayoutTransport implements OciTransport {
  constructor(
    private readonly fs: LayoutFsLike,
    private readonly dir: string,
  ) {}

  private blobPath(digest: Digest): string {
    return `${this.dir}/blobs/sha256/${digestHex(digest)}`;
  }

  async resolve(ref: ImageRef, opts?: { digest?: Digest }): Promise<ResolvedManifest> {
    let digest = opts?.digest ?? ref.digest;
    let mediaType = 'application/vnd.oci.image.manifest.v1+json';
    if (!digest) {
      const index = JSON.parse(await this.fs.readFileText(`${this.dir}/index.json`)) as {
        manifests: OciLayoutDescriptor[];
      };
      const wanted = ref.tag ?? 'latest';
      const found =
        index.manifests.find((m) => m.annotations?.['org.opencontainers.image.ref.name'] === wanted) ??
        index.manifests[0];
      if (!found) throw new Error(`No manifest for '${wanted}' in OCI layout at ${this.dir}`);
      digest = found.digest;
      mediaType = found.mediaType;
    }
    const bytes = await this.fs.readFile(this.blobPath(digest));
    const manifestDigest = await sha256(bytes);
    if (manifestDigest !== digest) {
      throw new Error(`Layout manifest ${digest} is corrupt (hashes to ${manifestDigest})`);
    }
    return { manifestDigest, mediaType, bytes };
  }

  async fetchBlob(_ref: ImageRef, digest: Digest): Promise<Uint8Array> {
    return this.fs.readFile(this.blobPath(digest));
  }
}
