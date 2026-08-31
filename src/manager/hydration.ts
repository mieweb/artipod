/**
 * Lazy hydration & site cache (plan Phase 6.6 — the OCI layer is the unit
 * of hydration; docs/browser.md + issue #1). A pulled pod materializes at
 * `index` level: manifest + config + published layer indexes; every file in
 * a lazy layer is a placeholder (stat/ls from the index, reads fail fast).
 * Opening content hydrates its winning layer — whole blob, digest-verified.
 * No eStargz/SOCI machinery: annotations + one small index artifact per
 * layer, Range only for byte-offset RESUME.
 */
import { digestHex, verifyDigest, isDigest, type Digest } from '../oci/digest.js';
import { gunzip, isGzip } from '../oci/gzip.js';
import { indexTar, parseLayerIndexArtifact, ANNOTATION_HYDRATION, ANNOTATION_LAYER_INDEX, ANNOTATION_LAYER_GROUP, type LayerEntry } from '../oci/tar.js';

export { ANNOTATION_HYDRATION, ANNOTATION_LAYER_INDEX, ANNOTATION_LAYER_GROUP };
import { mergeLayerEntries, mountOciView } from '../oci/view.js';
import type { ImageManifest } from '../oci/pull.js';
import { parseImageRef, type OciTransport } from '../oci/transport.js';
import type { OciStore } from '../oci/store.js';
import type { ZenFsLike } from '../sandbox/types.js';
import type { PodEvents, FetchStartEvent } from '../events.js';
import type { PodStore } from './pod-store.js';
import type { StoredRef } from '../oci/store.js';
import { storeTransport } from './sync.js';
import type { ProcProvider, ProcTree } from '../proc/registry.js';

const HYDRATION_DIR = '/.artipod/oci/hydration';
const PARTIAL_DIR = '/.artipod/oci/partial';

const decoder = new TextDecoder();

/** `**` crosses `/`, `*` doesn't; leading `/` on paths is ignored. */
export function pathGlobMatch(pattern: string, path: string): boolean {
  const p = path.replace(/^\/+/, '');
  const re = pattern
    .replace(/^\/+/, '')
    .split(/(\*\*|\*)/)
    .map((part) => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${re}$`).test(p);
}

export interface HydrationPolicy {
  /** Falls back to the layer annotation, then the size threshold. */
  default: 'eager' | 'lazy';
  /** Globs — layers containing matching paths hydrate up front. */
  eager?: string[];
  maxEagerLayerSize?: number;
}

export type Lane = FetchStartEvent['lane'];

export interface HydrationLayerState {
  ordinal: number;
  digest: Digest;
  diffId: Digest;
  size: number;
  state: 'hydrated' | 'placeholder';
  group?: string;
  /** True when this layer had no published index and degraded to a full fetch. */
  degraded?: boolean;
}

export interface HydrationState {
  ref: string;
  manifestDigest: Digest;
  layers: HydrationLayerState[];
}

export interface IndexPullResult {
  state: HydrationState;
  /** Bytes that actually crossed the wire in this pass. */
  transferredBytes: number;
}

// --- bandwidth lanes ---------------------------------------------------------

const LANE_ORDER: Lane[] = ['interactive', 'prefetch', 'background'];

interface QueuedTask {
  fn: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

/**
 * Three-lane scheduler: interactive ≻ prefetch ≻ background. One transfer
 * runs at a time; between tasks the highest-priority non-empty lane wins, so
 * a queued prefetch yields to interactive at layer granularity.
 */
export class BandwidthScheduler {
  private queues: Record<Lane, QueuedTask[]> = { interactive: [], prefetch: [], background: [] };
  private running = false;
  /** Completed task order — throughput/preemption assertions in tests. */
  readonly log: { lane: Lane; label?: string }[] = [];

  schedule<T>(lane: Lane, fn: () => Promise<T>, label?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues[lane].push({
        fn: async () => {
          const result = await fn();
          this.log.push({ lane, label });
          return result;
        },
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const lane = LANE_ORDER.find((l) => this.queues[l].length > 0);
        if (!lane) break;
        const task = this.queues[lane].shift()!;
        try {
          task.resolve(await task.fn());
        } catch (e) {
          task.reject(e);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

// --- resumable whole-blob fetch ----------------------------------------------

/** Optional PodStore extension: serve a blob from a byte offset (HTTP Range). */
export interface RangeReadable {
  getBlobRange(digest: Digest, start: number): Promise<Uint8Array>;
}

export const hasRange = (s: object): s is RangeReadable =>
  typeof (s as RangeReadable).getBlobRange === 'function';

/**
 * Fetch a whole layer blob with byte-offset resume: partial bytes persist
 * under /.artipod/oci/partial/<hex>, a retry continues from that offset, and
 * the completed blob must verify against its digest before use.
 */
export async function fetchBlobResumable(options: {
  digest: Digest;
  zfs: ZenFsLike;
  fetchRange: (start: number) => Promise<Uint8Array>;
  events?: PodEvents;
  lane?: Lane;
}): Promise<Uint8Array> {
  const { digest, zfs } = options;
  const p = zfs.promises;
  await p.mkdir(PARTIAL_DIR, { recursive: true });
  const partialPath = `${PARTIAL_DIR}/${digestHex(digest)}`;
  let partial = new Uint8Array(0);
  try {
    const prior = (await p.readFile(partialPath)) as Uint8Array;
    partial = new Uint8Array(prior.buffer as ArrayBuffer, prior.byteOffset, prior.byteLength);
  } catch {
    // fresh fetch
  }
  let rest: Uint8Array;
  try {
    rest = await options.fetchRange(partial.length);
  } catch (e) {
    // keep the partial for the next attempt
    if (partial.length > 0) await p.writeFile(partialPath, partial);
    throw e;
  }
  const whole = new Uint8Array(partial.length + rest.length);
  whole.set(partial, 0);
  whole.set(rest, partial.length);
  options.events?.emit('fetch:progress', { digest, received: whole.length });
  await verifyDigest(whole, digest, 'hydrated layer');
  await p.rm(partialPath, { force: true });
  return whole;
}

/** Test/diagnostic hook: persist a partial download as an interruption would. */
export async function persistPartial(zfs: ZenFsLike, digest: Digest, bytes: Uint8Array): Promise<void> {
  await zfs.promises.mkdir(PARTIAL_DIR, { recursive: true });
  await zfs.promises.writeFile(`${PARTIAL_DIR}/${digestHex(digest)}`, bytes);
}

// --- site cache ----------------------------------------------------------------

/**
 * LAN pull-through cache (the site cache manager's storage half): blobs are
 * served from the front store when present, fetched from the origin once
 * otherwise — digest-keyed and verified on receipt by `putBlob`. For
 * encrypted pods the cache holds ciphertext only, by construction. Refs stay
 * origin-fresh (they are mutable pointers).
 */
export class CachingPodStore implements PodStore {
  readonly counters = { frontHits: 0, originBlobFetches: 0 };

  constructor(
    private readonly front: PodStore,
    private readonly origin: PodStore,
  ) {}

  async hasBlob(digest: Digest): Promise<boolean> {
    return (await this.front.hasBlob(digest)) || this.origin.hasBlob(digest);
  }

  async getBlob(digest: Digest): Promise<Uint8Array> {
    if (await this.front.hasBlob(digest)) {
      this.counters.frontHits++;
      return this.front.getBlob(digest);
    }
    const bytes = await this.origin.getBlob(digest);
    this.counters.originBlobFetches++;
    await this.front.putBlob(bytes, digest); // verify-on-receipt
    return bytes;
  }

  async putBlob(bytes: Uint8Array, expected?: Digest): Promise<Digest> {
    const digest = await this.origin.putBlob(bytes, expected);
    await this.front.putBlob(bytes, digest);
    return digest;
  }

  async getRef(ref: string): Promise<StoredRef | null> {
    try {
      const fresh = await this.origin.getRef(ref);
      if (fresh) {
        try {
          await this.front.putRef(fresh.ref, fresh.manifestDigest, fresh.mediaType);
        } catch {
          // front may refuse pointers to blobs it doesn't hold yet — fine
        }
        return fresh;
      }
    } catch {
      // origin unreachable — fall back to the cached pointer
    }
    return this.front.getRef(ref);
  }

  async putRef(ref: string, manifestDigest: Digest, mediaType: string): Promise<void> {
    await this.origin.putRef(ref, manifestDigest, mediaType);
    await this.front.putRef(ref, manifestDigest, mediaType);
  }

  async listRefs(): Promise<StoredRef[]> {
    try {
      return await this.origin.listRefs();
    } catch {
      return this.front.listRefs();
    }
  }
}

// --- the hydrator --------------------------------------------------------------

export interface HydratorOptions {
  store: OciStore;
  zfs: ZenFsLike;
  /** Where lazy layers hydrate from: a manager store… */
  remote?: PodStore;
  /** …or a registry transport (remote wins when both are set). */
  transport?: OciTransport;
  events?: PodEvents;
  scheduler?: BandwidthScheduler;
  /** Applied when pullIndex gets no explicit policy. */
  policy?: HydrationPolicy;
}

export class Hydrator {
  readonly scheduler: BandwidthScheduler;
  private readonly inflight = new Set<string>();
  private readonly mounts = new Map<string, { at: string; unmount: () => void }>();

  constructor(private readonly options: HydratorOptions) {
    this.scheduler = options.scheduler ?? new BandwidthScheduler();
  }

  private get p() {
    return this.options.zfs.promises;
  }

  private statePath(ref: string): string {
    return `${HYDRATION_DIR}/${encodeURIComponent(ref)}.json`;
  }

  private async writeState(state: HydrationState): Promise<void> {
    await this.p.mkdir(HYDRATION_DIR, { recursive: true });
    await this.p.writeFile(this.statePath(state.ref), JSON.stringify(state, null, 2));
  }

  async stateFor(ref: string): Promise<HydrationState | null> {
    try {
      return JSON.parse((await this.p.readFile(this.statePath(ref), 'utf8')) as string) as HydrationState;
    } catch {
      return null;
    }
  }

  private transport(): OciTransport {
    if (this.options.remote) return storeTransport(this.options.remote);
    if (this.options.transport) return this.options.transport;
    throw new Error('hydration needs a remote (sync.remote) or an OCI transport — this pod is offline');
  }

  /**
   * `index`-level pull: manifest + config + published layer indexes move;
   * lazy layers become placeholders. Foreign layers without a published
   * index degrade gracefully to a full fetch (`degraded: true`).
   */
  async pullIndex(ref: string, policy?: HydrationPolicy): Promise<IndexPullResult> {
    const effective = policy ?? this.options.policy ?? { default: 'lazy' };
    const { store } = this.options;
    const transport = this.transport();
    const imageRef = parseImageRef(ref);
    let transferred = 0;

    const resolved = await transport.resolve(imageRef);
    transferred += resolved.bytes.length;
    await store.putBlob(resolved.bytes, resolved.manifestDigest);
    const manifest = JSON.parse(decoder.decode(resolved.bytes)) as ImageManifest;
    if (!manifest.config || !Array.isArray(manifest.layers)) {
      throw new Error(`'${ref}' is not an image manifest (media type ${resolved.mediaType})`);
    }

    const configBytes = await transport.fetchBlob(imageRef, manifest.config.digest);
    transferred += configBytes.length;
    await store.putBlob(configBytes, manifest.config.digest);
    const config = JSON.parse(decoder.decode(configBytes)) as { rootfs?: { diff_ids?: string[] } };
    const diffIds = config.rootfs?.diff_ids ?? [];

    const layers: HydrationLayerState[] = [];
    for (const [i, layer] of manifest.layers.entries()) {
      const diffId = diffIds[i];
      if (!diffId || !isDigest(diffId)) throw new Error(`config missing diff_id for layer ${i}`);
      const ann = layer.annotations ?? {};
      const indexDigest = ann[ANNOTATION_LAYER_INDEX];

      let lazy: boolean;
      if (ann[ANNOTATION_HYDRATION] === 'eager') lazy = false;
      else if (ann[ANNOTATION_HYDRATION] === 'lazy') lazy = true;
      else if (effective.maxEagerLayerSize !== undefined && layer.size > effective.maxEagerLayerSize) lazy = true;
      else lazy = effective.default === 'lazy';

      let entries: LayerEntry[] | null = null;
      if (lazy && indexDigest && isDigest(indexDigest)) {
        const indexBytes = await transport.fetchBlob(imageRef, indexDigest);
        transferred += indexBytes.length;
        await store.putBlob(indexBytes, indexDigest);
        entries = parseLayerIndexArtifact(decoder.decode(indexBytes)).entries;
        // Pull-time policy can promote layers whose paths the app wants NOW.
        if (effective.eager?.some((glob) => entries!.some((e) => pathGlobMatch(glob, e.path)))) lazy = false;
      } else if (lazy && !indexDigest) {
        lazy = false; // foreign image without published indexes: degrade to full pull
      }

      if (lazy && entries) {
        await store.putLayerIndex(diffId as Digest, entries);
        layers.push({
          ordinal: i,
          digest: layer.digest,
          diffId: diffId as Digest,
          size: layer.size,
          state: 'placeholder',
          ...(ann[ANNOTATION_LAYER_GROUP] ? { group: ann[ANNOTATION_LAYER_GROUP] } : {}),
        });
        continue;
      }

      const compressed = await transport.fetchBlob(imageRef, layer.digest);
      transferred += compressed.length;
      await store.putBlob(compressed, layer.digest);
      const tar = isGzip(compressed) ? await gunzip(compressed) : compressed;
      await verifyDigest(tar, diffId as Digest, 'layer diff');
      await store.putUncompressed(diffId as Digest, tar);
      await store.putLayerIndex(diffId as Digest, entries ?? indexTar(tar));
      layers.push({
        ordinal: i,
        digest: layer.digest,
        diffId: diffId as Digest,
        size: layer.size,
        state: 'hydrated',
        ...(ann[ANNOTATION_LAYER_GROUP] ? { group: ann[ANNOTATION_LAYER_GROUP] } : {}),
        ...(!indexDigest && effective.default === 'lazy' && !ann[ANNOTATION_HYDRATION] ? { degraded: true } : {}),
      });
    }

    await store.putRef(ref, resolved.manifestDigest, resolved.mediaType);
    const state: HydrationState = { ref, manifestDigest: resolved.manifestDigest, layers };
    await this.writeState(state);
    return { state, transferredBytes: transferred };
  }

  /** Layer indexes + bytes (null for placeholders) in manifest order. */
  async loadView(ref: string): Promise<{ layers: LayerEntry[][]; layerBytes: (Uint8Array | null)[]; state: HydrationState }> {
    const state = await this.stateFor(ref);
    if (!state) throw new Error(`no hydration state for '${ref}' — pull it with --index first`);
    const layers: LayerEntry[][] = [];
    const layerBytes: (Uint8Array | null)[] = [];
    for (const layer of state.layers) {
      layers.push((await this.options.store.getLayerIndex(layer.diffId)).entries);
      layerBytes.push(layer.state === 'hydrated' ? await this.options.store.getUncompressed(layer.diffId) : null);
    }
    return { layers, layerBytes, state };
  }

  /** Mount (or remount) the ref's view — placeholders and all. */
  async mount(ref: string, at: string): Promise<void> {
    const { layers, layerBytes } = await this.loadView(ref);
    this.mounts.get(ref)?.unmount();
    const unmount = await mountOciView({ zfs: this.options.zfs, at, layers, layerBytes, name: `hydrated:${ref}` });
    this.mounts.set(ref, { at, unmount });
  }

  unmount(ref: string): void {
    this.mounts.get(ref)?.unmount();
    this.mounts.delete(ref);
  }

  /** Placeholder layers whose winning entries match the glob/path. */
  private async backingLayers(ref: string, pattern: string, want: 'placeholder' | 'hydrated'): Promise<HydrationLayerState[]> {
    const { layers, state } = await this.loadView(ref);
    const merged = mergeLayerEntries(layers);
    const ordinals = new Set<number>();
    for (const [path, entry] of merged.entries) {
      if (entry.type === 'file' && (pathGlobMatch(pattern, path) || path.replace(/^\/+/, '') === pattern.replace(/^\/+/, ''))) {
        ordinals.add(entry.layer);
      }
    }
    return state.layers.filter((l) => ordinals.has(l.ordinal) && l.state === want);
  }

  /**
   * Hydrate every lazy layer backing `pattern`: whole blob per layer,
   * byte-offset resume when the source supports Range, digest-verified,
   * indexed once, then live mounts refresh.
   */
  async hydrate(ref: string, pattern: string, lane: Lane = 'interactive'): Promise<{ layers: number; bytes: number }> {
    const targets = await this.backingLayers(ref, pattern, 'placeholder');
    let bytes = 0;
    for (const layer of targets) {
      await this.scheduler.schedule(
        lane,
        async () => {
          const { store, events, zfs, remote } = this.options;
          events?.emit('fetch:start', { digest: layer.digest, lane, size: layer.size });
          this.inflight.add(layer.digest);
          try {
            const compressed =
              remote && hasRange(remote)
                ? await fetchBlobResumable({ digest: layer.digest, zfs, events, lane, fetchRange: (start) => remote.getBlobRange(layer.digest, start) })
                : await this.transport().fetchBlob(parseImageRef(ref), layer.digest);
            await store.putBlob(compressed, layer.digest);
            const tar = isGzip(compressed) ? await gunzip(compressed) : compressed;
            await verifyDigest(tar, layer.diffId, 'hydrated layer diff');
            await store.putUncompressed(layer.diffId, tar);
            bytes += compressed.length;
            events?.emit('fetch:done', { digest: layer.digest, ok: true, bytes: compressed.length });
          } catch (e) {
            events?.emit('fetch:done', { digest: layer.digest, ok: false, bytes: 0 });
            throw e;
          } finally {
            this.inflight.delete(layer.digest);
          }
        },
        layer.digest,
      );
      layer.state = 'hydrated';
    }
    if (targets.length > 0) {
      const state = (await this.stateFor(ref))!;
      for (const t of targets) state.layers[t.ordinal].state = 'hydrated';
      await this.writeState(state);
      const mount = this.mounts.get(ref);
      if (mount) await this.mount(ref, mount.at);
    }
    return { layers: targets.length, bytes };
  }

  /** Evict layer blobs + twins; indexes and placeholders stay (round-trips). */
  async dehydrate(ref: string, pattern: string): Promise<{ layers: number }> {
    const targets = await this.backingLayers(ref, pattern, 'hydrated');
    const { store } = this.options;
    for (const layer of targets) {
      await store.deleteBlob(layer.digest);
      await store.deleteUncompressed(layer.diffId);
    }
    if (targets.length > 0) {
      const state = (await this.stateFor(ref))!;
      for (const t of targets) state.layers[t.ordinal].state = 'placeholder';
      await this.writeState(state);
      const mount = this.mounts.get(ref);
      if (mount) await this.mount(ref, mount.at);
    }
    return { layers: targets.length };
  }

  /** `/proc/hydration` — layer states + in-flight transfers. */
  procProvider(): ProcProvider {
    return {
      name: 'hydration',
      description: 'lazy-layer hydration state (plan Phase 6.6)',
      mode: 'ro',
      read: async (): Promise<ProcTree> => {
        const refs: HydrationState[] = [];
        try {
          const names = (await this.p.readdir(HYDRATION_DIR)) as string[];
          for (const name of names) {
            refs.push(JSON.parse((await this.p.readFile(`${HYDRATION_DIR}/${name}`, 'utf8')) as string) as HydrationState);
          }
        } catch {
          // nothing pulled yet
        }
        return {
          'state.json': JSON.stringify({ refs, inflight: [...this.inflight] }, null, 2),
        };
      },
    };
  }
}

/** OpenAI-wire agent tool: warm a glob's backing layers inside the prefetch budget. */
export function makePrefetchTool(hydrator: Hydrator, defaultRef?: string) {
  return {
    definition: {
      type: 'function' as const,
      function: {
        name: 'prefetch',
        description:
          'Prefetch (hydrate) dehydrated pod content by path or glob so later reads are instant. Runs in the prefetch bandwidth lane — never blocks interactive work. In-pod and audit-visible; no approval needed.',
        parameters: {
          type: 'object' as const,
          properties: {
            paths: { type: 'array', items: { type: 'string' }, description: 'Paths or globs to warm (e.g. dicom/study-4/**)' },
            ref: { type: 'string', description: `Image ref to hydrate${defaultRef ? ` (default ${defaultRef})` : ''}` },
            priority: { type: 'string', enum: ['high', 'low'], description: 'high = prefetch lane (default), low = background lane' },
          },
          required: ['paths'],
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const ref = typeof args.ref === 'string' && args.ref ? args.ref : defaultRef;
      if (!ref) return { success: false as const, content: '', error: 'no ref given and the pod has no default hydration ref' };
      const lane: Lane = args.priority === 'low' ? 'background' : 'prefetch';
      const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
      if (paths.length === 0) return { success: false as const, content: '', error: 'paths is required' };
      const results = [];
      for (const path of paths) {
        const r = await hydrator.hydrate(ref, path, lane);
        results.push({ path, ...r });
      }
      return { success: true as const, content: JSON.stringify({ ref, lane, results }) };
    },
  };
}
