import { NextResponse } from 'next/server';
import { nodePodFs } from '@artipod/core';
import { OciLayoutPodStore } from '@artipod/core/manager';
import type { Digest } from '@artipod/core/oci';

/**
 * /api/pods — this deployment's pod manager sync surface (plan Phase 6):
 * digest-addressed blobs + refs over the OCI image-layout directory store
 * (Decision #6 — inspectable with skopeo/crane, trivial to back up).
 * Digests verify on both ends; auth/rate policy is this app's concern and
 * intentionally minimal in the dev demo.
 */
export const dynamic = 'force-dynamic';

const storeDir = process.env.ARTIPOD_STORE_DIR ?? '.artipod-store';
let storePromise: Promise<OciLayoutPodStore> | null = null;

function getStore(): Promise<OciLayoutPodStore> {
  if (!storePromise) {
    storePromise = (async () => {
      const store = new OciLayoutPodStore(nodePodFs(), storeDir);
      await store.init();
      return store;
    })();
  }
  return storePromise;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export async function GET(request: Request, { params }: { params: { path: string[] } }) {
  const store = await getStore();
  const [kind, digest] = params.path ?? [];
  if (kind === 'blobs' && digest && DIGEST_RE.test(digest)) {
    try {
      const bytes = await store.getBlob(digest as Digest);
      return new Response(bytes as BodyInit, { headers: { 'content-type': 'application/octet-stream' } });
    } catch {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
  }
  if (kind === 'refs') {
    const name = new URL(request.url).searchParams.get('name');
    if (name) {
      const ref = await store.getRef(name);
      return ref ? NextResponse.json(ref) : NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    return NextResponse.json(await store.listRefs());
  }
  return NextResponse.json({ error: 'usage: /api/pods/blobs/<digest> | /api/pods/refs[?name=]' }, { status: 400 });
}

export async function HEAD(_request: Request, { params }: { params: { path: string[] } }) {
  const store = await getStore();
  const [kind, digest] = params.path ?? [];
  if (kind === 'blobs' && digest && DIGEST_RE.test(digest)) {
    return new Response(null, { status: (await store.hasBlob(digest as Digest)) ? 200 : 404 });
  }
  return new Response(null, { status: 400 });
}

export async function PUT(request: Request, { params }: { params: { path: string[] } }) {
  const store = await getStore();
  const [kind, digest] = params.path ?? [];
  if (kind === 'blobs' && digest && DIGEST_RE.test(digest)) {
    const bytes = new Uint8Array(await request.arrayBuffer());
    try {
      await store.putBlob(bytes, digest as Digest); // verifies — tampered uploads bounce
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
    return new Response(null, { status: 201 });
  }
  if (kind === 'refs') {
    const body = (await request.json()) as { ref?: string; manifestDigest?: string; mediaType?: string };
    if (!body.ref || !body.manifestDigest || !DIGEST_RE.test(body.manifestDigest)) {
      return NextResponse.json({ error: 'ref and manifestDigest required' }, { status: 400 });
    }
    if (!(await store.hasBlob(body.manifestDigest as Digest))) {
      return NextResponse.json({ error: 'push the manifest blob before the ref' }, { status: 409 });
    }
    await store.putRef(body.ref, body.manifestDigest as Digest, body.mediaType ?? 'application/vnd.oci.image.manifest.v1+json');
    return new Response(null, { status: 201 });
  }
  return NextResponse.json({ error: 'bad request' }, { status: 400 });
}
