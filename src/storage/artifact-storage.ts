import type { StorageSession, StorageSessionInfo } from './session.js';
import { readStorageTextFile, writeStorageTextFile } from './text-file.js';
import { resolveStorageContext } from './context.js';

/** Logical identity supplied by the host registry, never an authorization grant. */
export interface ArtifactStorageReference {
  readonly artipodId: string;
  readonly artifactId: string;
}

export interface ArtifactBlobMetadata {
  mediaType: string;
  filename?: string;
}

export interface ArtifactStorageOptions {
  /** Borrowed application owner. Disposing this handle never closes its session. */
  session: StorageSession;
  reference: ArtifactStorageReference;
  /** Recheck the current principal's permission; throw to deny the operation. */
  authorize(reference: ArtifactStorageReference, action: 'read' | 'write'): void | Promise<void>;
  /** This first adapter buffers bounded objects. Large-file streaming is separate work. */
  maxBytes?: number;
}

export interface ArtifactStorageReadOptions { signal?: AbortSignal }

export interface ArtifactStorageSnapshot {
  revision: string;
  source: ReadableStream<Uint8Array>;
}

export const DEFAULT_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
const REFERENCE_PREFIX = 'artipod-blob:v1:';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const abortError = () => new DOMException('Artifact operation was aborted', 'AbortError');

/**
 * Immutable byte objects under one host-authorized Artifact in a managed vault.
 * All content and metadata use the session's encrypted filesystem. A returned
 * reference means both files completed the session's durability drain.
 */
export class ArtifactStorage {
  readonly reference: Readonly<ArtifactStorageReference>;
  readonly maxBytes: number;
  private readonly scope: Promise<string>;
  private info: StorageSessionInfo | null = null;
  private closed = false;
  private readonly revocations = new Set<(reason: unknown) => void>();
  private readonly unsubscribe: () => void;
  private readonly teardown: () => Promise<void>;

  constructor(private readonly options: ArtifactStorageOptions) {
    for (const id of [options.reference.artipodId, options.reference.artifactId]) {
      if (typeof id !== 'string' || !id.trim() || id.length > 4096) throw new Error('Artifact storage requires nonempty logical identities');
    }
    this.maxBytes = options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0 || this.maxBytes > DEFAULT_ARTIFACT_MAX_BYTES) {
      throw new Error(`Artifact storage maxBytes must be between 1 and ${DEFAULT_ARTIFACT_MAX_BYTES}`);
    }
    this.reference = Object.freeze({ ...options.reference });
    this.scope = crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([this.reference.artipodId, this.reference.artifactId])))
      .then(bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join(''));
    this.unsubscribe = options.session.subscribe(() => {
      if (options.session.getSnapshot().status !== 'open') this.revoke(new Error('Artifact storage is unavailable or locked'));
    });
    this.teardown = options.session.registerTeardown(async () => this.dispose(), 'Artifact byte storage');
  }

  private revoke(reason: unknown): void {
    for (const revoke of [...this.revocations]) revoke(reason);
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.revoke(new Error('Artifact storage handle was closed'));
    this.info = null;
  }

  /** Releases this consumer and its read buffers, retaining the shared vault. */
  close(): Promise<void> { return this.teardown(); }

  private assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? abortError();
    if (this.closed) throw new Error('Artifact storage handle was closed');
    this.info?.assertAccess();
  }

  private async access(action: 'read' | 'write', signal?: AbortSignal): Promise<StorageSessionInfo> {
    this.assertActive(signal);
    await this.options.authorize(this.reference, action);
    this.assertActive(signal);
    const info = this.info ?? await this.options.session.open();
    this.assertActive(signal);
    if (!info.encrypted || info.protection !== 'encrypted' || info.memoryOnly) throw new Error('Artifact storage requires a managed encrypted persistent session');
    resolveStorageContext(info, info.zfs, 'protected');
    this.info = info;
    return info;
  }

  private async location(ref: string): Promise<{ path: string; scope: string }> {
    const scope = await this.scope;
    const prefix = `${REFERENCE_PREFIX}${scope}:`;
    if (typeof ref !== 'string' || !ref.startsWith(prefix) || !UUID.test(ref.slice(prefix.length))) throw new Error('Invalid or foreign Artifact blob reference');
    return { scope, path: `/.artipod-artifacts/v1/${scope}/${ref.slice(prefix.length)}` };
  }

  private async collect(source: Uint8Array | ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
    this.assertActive(signal);
    if (source instanceof Uint8Array) {
      if (source.byteLength > this.maxBytes) throw new Error(`Artifact exceeds the ${this.maxBytes}-byte MVP limit`);
      return new Uint8Array(source);
    }
    const reader = source.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    let failure: unknown;
    const cancel = (reason: unknown) => { failure = reason; void reader.cancel(reason).catch(() => {}); };
    const abort = () => cancel(signal?.reason ?? abortError());
    this.revocations.add(cancel);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      for (;;) {
        this.assertActive(signal);
        if (failure) throw failure;
        const part = await reader.read();
        this.assertActive(signal);
        if (failure) throw failure;
        if (part.done) break;
        if (!(part.value instanceof Uint8Array)) throw new Error('Artifact source must yield Uint8Array chunks');
        length += part.value.byteLength;
        if (length > this.maxBytes) throw new Error(`Artifact exceeds the ${this.maxBytes}-byte MVP limit`);
        chunks.push(new Uint8Array(part.value));
      }
      const result = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      return result;
    } catch (error) { cancel(error); throw error; }
    finally {
      this.revocations.delete(cancel);
      signal?.removeEventListener('abort', abort);
      chunks.forEach(chunk => chunk.fill(0));
      reader.releaseLock();
    }
  }

  async put(source: Uint8Array | ReadableStream<Uint8Array>, metadata: ArtifactBlobMetadata, options: ArtifactStorageReadOptions = {}): Promise<string> {
    if (typeof metadata.mediaType !== 'string' || !metadata.mediaType || metadata.mediaType.length > 1024 ||
        (metadata.filename !== undefined && (typeof metadata.filename !== 'string' || metadata.filename.length > 4096))) throw new Error('Invalid Artifact blob metadata');
    const info = await this.access('write', options.signal);
    const bytes = await this.collect(source, options.signal);
    try {
      const scope = await this.scope;
      const ref = `${REFERENCE_PREFIX}${scope}:${crypto.randomUUID()}`;
      const { path } = await this.location(ref);
      const directory = path.slice(0, path.lastIndexOf('/'));
      this.assertActive(options.signal);
      // A host permission may have changed while the source was arriving.
      await this.access('write', options.signal);
      await info.zfs.promises.mkdir(directory, { recursive: true });
      await info.zfs.promises.writeFile(path, bytes, { flag: 'wx' });
      await info.zfs.promises.writeFile(`${path}.json`, JSON.stringify({ mediaType: metadata.mediaType,
        ...(metadata.filename === undefined ? {} : { filename: metadata.filename }), byteLength: bytes.byteLength }), { flag: 'wx' });
      await info.flush();
      this.assertActive(options.signal);
      return ref;
    } finally { bytes.fill(0); }
  }

  async read(ref: string, options: ArtifactStorageReadOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const { path } = await this.location(ref);
    const info = await this.access('read', options.signal);
    const stat = await info.zfs.promises.stat(path);
    if (stat.size > this.maxBytes) throw new Error(`Artifact exceeds the ${this.maxBytes}-byte MVP limit`);
    const loaded = await info.zfs.promises.readFile(path) as Uint8Array;
    try { this.assertActive(options.signal); }
    catch (error) { loaded.fill(0); throw error; }
    if (loaded.byteLength > this.maxBytes) { loaded.fill(0); throw new Error(`Artifact exceeds the ${this.maxBytes}-byte MVP limit`); }
    let bytes: Uint8Array | null = loaded;
    let offset = 0;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const clear = () => { bytes?.fill(0); bytes = null; this.revocations.delete(revoke); options.signal?.removeEventListener('abort', abort); };
    const revoke = (reason: unknown) => { if (bytes) { clear(); controller.error(reason); } };
    const abort = () => revoke(options.signal?.reason ?? abortError());
    const stream = new ReadableStream<Uint8Array>({
      start: next => { controller = next; },
      pull: async next => {
        try {
          await this.access('read', options.signal);
          if (!bytes) return;
          if (offset === bytes.length) { clear(); next.close(); return; }
          const end = Math.min(offset + 64 * 1024, bytes.length);
          // Node-compatible filesystems may return Buffer, whose slice aliases.
          next.enqueue(new Uint8Array(bytes.subarray(offset, end)));
          offset = end;
        } catch (error) { revoke(error); }
      },
      cancel: () => clear(),
    }, { highWaterMark: 0 });
    this.revocations.add(revoke);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    return stream;
  }

  /** Save an immutable snapshot, then durably advance this Artifact's current head. */
  async saveSnapshot(source: Uint8Array | ReadableStream<Uint8Array>, metadata: ArtifactBlobMetadata, options: ArtifactStorageReadOptions = {}): Promise<string> {
    const revision = await this.put(source, metadata, options);
    const info = await this.access('write', options.signal);
    const directory = `/.artipod-artifacts/v1/${await this.scope}`;
    // The shared filesystem/path queue also serializes heads from sibling views.
    await writeStorageTextFile({ zfs: info.zfs, path: `${directory}/head`, previousPath: `${directory}/head.previous` }, revision);
    this.assertActive(options.signal);
    return revision;
  }

  /** The current durable snapshot; the host does not persist a ref elsewhere. */
  async loadSnapshot(options: ArtifactStorageReadOptions = {}): Promise<ArtifactStorageSnapshot | null> {
    const info = await this.access('read', options.signal);
    const directory = `/.artipod-artifacts/v1/${await this.scope}`;
    const revision = await readStorageTextFile({ zfs: info.zfs, path: `${directory}/head`, previousPath: `${directory}/head.previous` });
    if (revision === null) return null;
    return { revision, source: await this.read(revision, options) };
  }
}

export function createArtifactStorage(options: ArtifactStorageOptions): ArtifactStorage { return new ArtifactStorage(options); }
