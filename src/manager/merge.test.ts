/**
 * mergeHeads — the Phase F convergence laws, pinned by digest equality
 * (sync plan §3.6, D8/D9): fast-forward, disjoint union, per-path LWW,
 * commutativity/idempotence/associativity, D9 content mergers (toy
 * sorted-line union — core stays yjs-free), and deletion clocks.
 */
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256, type Digest } from '../oci/digest.js';
import { gunzip, isGzip } from '../oci/gzip.js';
import { indexTar } from '../oci/tar.js';
import { mergeLayerEntries } from '../oci/view.js';
import type { ImageManifest } from '../oci/pull.js';
import type { StoredRef } from '../oci/store.js';
import type { PodStore } from './pod-store.js';
import { publishDirectory } from '../server/folder.js';
import { mergeHeads, isAncestor, type ContentMerger } from './merge.js';

function memStore(): PodStore {
  const blobs = new Map<string, Uint8Array>();
  const refs = new Map<string, StoredRef>();
  return {
    hasBlob: async (d) => blobs.has(d),
    async getBlob(d) {
      const b = blobs.get(d);
      if (!b) throw new Error(`mem store: no blob ${d}`);
      return b;
    },
    async putBlob(bytes, expected) {
      const digest = expected ?? (await sha256(bytes));
      blobs.set(digest, new Uint8Array(bytes));
      return digest as Digest;
    },
    getRef: async (r) => refs.get(r) ?? null,
    async putRef(ref, manifestDigest, mediaType) {
      refs.set(ref, { ref, manifestDigest, mediaType, pulledAt: new Date().toISOString() });
    },
    listRefs: async () => [...refs.values()],
  };
}

const decoder = new TextDecoder();

/** path → content of a head's merged view (whiteouts applied). */
async function treeOf(store: PodStore, digest: Digest): Promise<Map<string, string>> {
  const manifest = JSON.parse(decoder.decode(await store.getBlob(digest))) as ImageManifest;
  const perLayer = [];
  const bytesByLayer: Uint8Array[] = [];
  for (const layer of manifest.layers) {
    const compressed = await store.getBlob(layer.digest);
    const tar = isGzip(compressed) ? await gunzip(compressed) : compressed;
    perLayer.push(indexTar(tar));
    bytesByLayer.push(tar);
  }
  const out = new Map<string, string>();
  for (const [path, entry] of mergeLayerEntries(perLayer).entries) {
    if (entry.type !== 'dir') {
      out.set(path, decoder.decode(bytesByLayer[entry.layer].subarray(entry.offset, entry.offset + entry.size)));
    }
  }
  return out;
}

/** The semantic state (layers + config), independent of parents annotations. */
async function stateKey(store: PodStore, digest: Digest): Promise<string> {
  const manifest = JSON.parse(decoder.decode(await store.getBlob(digest))) as ImageManifest;
  return JSON.stringify({ config: manifest.config.digest, layers: manifest.layers.map((l) => l.digest) });
}

let dir: string;
let store: PodStore;
const REF = 'folder/lab:latest';
const T0 = new Date('2026-08-30T10:00:00Z');
const T1 = new Date('2026-08-30T11:00:00Z');
const T2 = new Date('2026-08-30T12:00:00Z');

async function writeTree(files: Record<string, string>, stamps: Record<string, Date>): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(join(dir, dirname(rel)), { recursive: true });
    await writeFile(join(dir, rel), content);
  }
  // Deterministic clocks: publish uses mtime as the LWW register. Only
  // explicitly stamped files "changed" — the rest keep the T0 base clock.
  for (const rel of Object.keys(files)) {
    const stamp = stamps[rel] ?? T0;
    await utimes(join(dir, rel), stamp, stamp);
  }
}

/** Publish `files` as a head whose parent is `parent` (rewinds the ref first). */
async function headFrom(
  parent: Digest | null,
  files: Record<string, string>,
  actor: string,
  stamps: Record<string, Date> = {},
): Promise<Digest> {
  if (parent) await store.putRef(REF, parent, 'application/vnd.oci.image.manifest.v1+json');
  await writeTree(files, stamps);
  const result = await publishDirectory(store, dir, REF, { actor });
  return result.manifestDigest;
}

const BASE = { 'readme.md': 'hello\n', 'docs/a.md': 'alpha v0\n', 'docs/b.md': 'beta v0\n' };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'merge-'));
  store = memStore();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('mergeHeads', () => {
  it('fast-forwards when one head contains the other; merge(A,A) is A', async () => {
    const v0 = await headFrom(null, BASE, 'srv');
    const v1 = await headFrom(v0, { ...BASE, 'docs/a.md': 'alpha v1\n' }, 'srv', { 'docs/a.md': T1 });
    expect((await mergeHeads(store, v1, v0)).manifestDigest).toBe(v1);
    expect((await mergeHeads(store, v0, v1)).manifestDigest).toBe(v1);
    expect((await mergeHeads(store, v1, v1)).manifestDigest).toBe(v1);
  });

  it('disjoint edits union; commutative by manifest digest; result descends from both', async () => {
    const v0 = await headFrom(null, BASE, 'srv');
    const a = await headFrom(v0, { ...BASE, 'docs/a.md': 'alpha by A\n' }, 'actor-a', { 'docs/a.md': T1 });
    const b = await headFrom(v0, { ...BASE, 'docs/b.md': 'beta by B\n' }, 'actor-b', { 'docs/b.md': T2 });

    const ab = await mergeHeads(store, a, b);
    const ba = await mergeHeads(store, b, a);
    expect(ab.kind).toBe('merged');
    expect(ab.manifestDigest).toBe(ba.manifestDigest); // commutativity — the convergence test

    const tree = await treeOf(store, ab.manifestDigest);
    expect(tree.get('/docs/a.md')).toBe('alpha by A\n');
    expect(tree.get('/docs/b.md')).toBe('beta by B\n');
    expect(tree.get('/readme.md')).toBe('hello\n');

    // Idempotence: the merged head already contains each input.
    expect((await mergeHeads(store, ab.manifestDigest, a)).manifestDigest).toBe(ab.manifestDigest);
    expect(await isAncestor(store, a, ab.manifestDigest)).toBe(true);
    expect(await isAncestor(store, b, ab.manifestDigest)).toBe(true);
  });

  it('same-file conflict: newer (mtime, actor) wins everywhere; loser stays reachable', async () => {
    const v0 = await headFrom(null, BASE, 'srv');
    const a = await headFrom(v0, { ...BASE, 'docs/a.md': 'A wrote this\n' }, 'actor-a', { 'docs/a.md': T1 });
    const b = await headFrom(v0, { ...BASE, 'docs/a.md': 'B wrote this later\n' }, 'actor-b', { 'docs/a.md': T2 });

    const ab = await mergeHeads(store, a, b);
    const ba = await mergeHeads(store, b, a);
    expect(ab.manifestDigest).toBe(ba.manifestDigest);
    expect(ab.lwwPaths).toEqual(['/docs/a.md']);
    expect((await treeOf(store, ab.manifestDigest)).get('/docs/a.md')).toBe('B wrote this later\n');
    // The losing head is a parent — its bytes remain recoverable.
    expect(await isAncestor(store, a, ab.manifestDigest)).toBe(true);
    expect((await treeOf(store, a)).get('/docs/a.md')).toBe('A wrote this\n');
  });

  it('associativity: three actors converge to the same tree in any merge order', async () => {
    const v0 = await headFrom(null, BASE, 'srv');
    const a = await headFrom(v0, { ...BASE, 'docs/a.md': 'from A\n' }, 'actor-a', { 'docs/a.md': T1 });
    const b = await headFrom(v0, { ...BASE, 'docs/b.md': 'from B\n' }, 'actor-b', { 'docs/b.md': T1 });
    const c = await headFrom(v0, { ...BASE, 'readme.md': 'from C\n' }, 'actor-c', { 'readme.md': T2 });

    const abC = await mergeHeads(store, (await mergeHeads(store, a, b)).manifestDigest, c);
    const aBC = await mergeHeads(store, a, (await mergeHeads(store, b, c)).manifestDigest);
    // Parents annotations differ across orders by construction — the
    // semantic state (layers + config) is what must converge.
    expect(await stateKey(store, abC.manifestDigest)).toBe(await stateKey(store, aBC.manifestDigest));
    const tree = await treeOf(store, abC.manifestDigest);
    expect(tree.get('/docs/a.md')).toBe('from A\n');
    expect(tree.get('/docs/b.md')).toBe('from B\n');
    expect(tree.get('/readme.md')).toBe('from C\n');
  });

  it('D9 content merger: sorted-line union merges both sides, commutatively', async () => {
    const union: ContentMerger = (x, y) => {
      const lines = new Set([...decoder.decode(x).split('\n'), ...decoder.decode(y).split('\n')].filter(Boolean));
      return new TextEncoder().encode([...lines].sort().join('\n') + '\n');
    };
    const base = { ...BASE, 'notes.union': 'shared\n' };
    const v0 = await headFrom(null, base, 'srv');
    const a = await headFrom(v0, { ...base, 'notes.union': 'shared\nfrom-a\n' }, 'actor-a', { 'notes.union': T1 });
    const b = await headFrom(v0, { ...base, 'notes.union': 'shared\nfrom-b\n' }, 'actor-b', { 'notes.union': T2 });

    const mergers = { '**/*.union': union };
    const ab = await mergeHeads(store, a, b, { mergers });
    const ba = await mergeHeads(store, b, a, { mergers });
    expect(ab.manifestDigest).toBe(ba.manifestDigest);
    expect(ab.contentMergedPaths).toEqual(['/notes.union']);
    expect((await treeOf(store, ab.manifestDigest)).get('/notes.union')).toBe('from-a\nfrom-b\nshared\n');
  });

  it('deletions: untouched-vs-delete deletes; edit survives an older deletion', async () => {
    const v0 = await headFrom(null, BASE, 'srv');
    // A deletes b.md (publish absence — unclocked); B leaves it untouched.
    const a = await headFrom(v0, { 'readme.md': BASE['readme.md'], 'docs/a.md': BASE['docs/a.md'] }, 'actor-a');
    const untouched = await headFrom(v0, { ...BASE, 'docs/a.md': 'edited elsewhere\n' }, 'actor-b', { 'docs/a.md': T2 });
    const merged = await mergeHeads(store, a, untouched);
    const tree = await treeOf(store, merged.manifestDigest);
    expect(tree.has('/docs/b.md')).toBe(false); // deletion wins over untouched
    expect(tree.get('/docs/a.md')).toBe('edited elsewhere\n');

    // B edits b.md concurrently — an unclocked deletion loses to the edit.
    const editors = await headFrom(v0, { ...BASE, 'docs/b.md': 'B kept working\n' }, 'actor-c', { 'docs/b.md': T2 });
    const merged2 = await mergeHeads(store, a, editors);
    expect((await treeOf(store, merged2.manifestDigest)).get('/docs/b.md')).toBe('B kept working\n');
  });
});
