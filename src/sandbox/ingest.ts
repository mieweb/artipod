/**
 * Ingest — files and media enter the pod programmatically (docs/browser.md
 * §Ingest API, the first Phase 7 slice).
 *
 *   put(path, Blob | File | bytes | string)   whole object, digest included
 *   open(path).append(chunk) … close()        streaming (MediaRecorder timeslices)
 *
 * Every appended chunk reaches the backend as it lands, so a crashed tab keeps
 * partial audio/video at its pod path; `close()` seals the file and emits
 * `fs:changed`. `mime` is advisory (ZenFS has no xattrs) — it is echoed back
 * so adapters can record it alongside the path.
 */
import type { PodEvents } from '../events.js';
import type { Digest } from '../oci/digest.js';
import { sha256 } from '../oci/digest.js';
import { dirnamePosix, normalizePosix } from '../pathUtils.js';
import type { ZenFsLike } from './types.js';

export type IngestData = Blob | Uint8Array | ArrayBuffer | string;

export interface IngestOptions {
  /** Advisory media type; echoed back in the result. */
  mime?: string;
}

export interface IngestResult {
  path: string;
  size: number;
  mime?: string;
}

export interface IngestPutResult extends IngestResult {
  digest: Digest;
}

export interface IngestWriter {
  readonly path: string;
  /** Bytes written so far. */
  readonly size: number;
  append(chunk: Blob | Uint8Array | ArrayBuffer): Promise<void>;
  /** Seal the file (emits `fs:changed`). Digest is computed over the sealed bytes. */
  close(): Promise<IngestPutResult>;
  /** Discard: closes the handle and removes the partial file. */
  abort(): Promise<void>;
}

export interface Ingest {
  put(path: string, data: IngestData, opts?: IngestOptions): Promise<IngestPutResult>;
  open(path: string, opts?: IngestOptions): IngestWriter;
}

async function toBytes(data: Blob | Uint8Array | ArrayBuffer | string): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

function targetPath(path: string): string {
  if (!path.startsWith('/')) throw new Error(`ingest: path must be absolute (got '${path}')`);
  const p = normalizePosix(path);
  if (p === '/' || p.endsWith('/')) throw new Error(`ingest: '${path}' is not a file path`);
  return p;
}

type Handle = Awaited<ReturnType<ZenFsLike['promises']['open']>>;

export function createIngest(zfs: ZenFsLike, events?: PodEvents): Ingest {
  const fsp = zfs.promises;
  const changed = (path: string) => events?.emit('fs:changed', { paths: [path], origin: 'ingest' });

  return {
    async put(path, data, opts) {
      const p = targetPath(path);
      const bytes = await toBytes(data);
      await fsp.mkdir(dirnamePosix(p), { recursive: true });
      await fsp.writeFile(p, bytes);
      changed(p);
      return { path: p, size: bytes.byteLength, digest: await sha256(bytes), mime: opts?.mime };
    },

    open(path, opts) {
      const p = targetPath(path);
      let size = 0;
      let done = false;
      let handle: Promise<Handle> | null = null;
      // Serialize appends: MediaRecorder fires timeslices faster than a slow backend flushes.
      let chain: Promise<unknown> = Promise.resolve();

      const ensureOpen = () =>
        (handle ??= (async () => {
          await fsp.mkdir(dirnamePosix(p), { recursive: true });
          return fsp.open(p, 'w');
        })());

      const enqueue = <T>(step: () => Promise<T>): Promise<T> => {
        const next = chain.then(step);
        chain = next.catch(() => undefined);
        return next;
      };

      return {
        path: p,
        get size() {
          return size;
        },
        append(chunk) {
          return enqueue(async () => {
            if (done) throw new Error(`ingest: '${p}' is closed`);
            const bytes = await toBytes(chunk);
            if (bytes.byteLength === 0) return;
            const h = await ensureOpen();
            await h.write(bytes, 0, bytes.byteLength, size);
            size += bytes.byteLength;
          });
        },
        close() {
          return enqueue(async () => {
            if (done) throw new Error(`ingest: '${p}' is closed`);
            done = true;
            const h = await ensureOpen();
            await h.close();
            const sealed = await fsp.readFile(p);
            changed(p);
            return { path: p, size, digest: await sha256(sealed), mime: opts?.mime };
          });
        },
        abort() {
          return enqueue(async () => {
            if (done) return;
            done = true;
            if (handle) {
              try {
                await (await handle).close();
              } catch {
                // already closed or never materialized
              }
              await fsp.rm(p, { force: true });
              changed(p);
            }
          });
        },
      };
    },
  };
}
