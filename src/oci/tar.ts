/**
 * Tar indexer (issue #1 step 2): parse an (uncompressed) layer tar into
 * `LayerEntry[]` — the unit the whole OCI stack builds on. The original blob
 * stays immutable; entries carry offsets into it (decompress-once policy
 * pairs each compressed original with an uncompressed content-addressed
 * twin, and reads slice that twin).
 *
 * Handles ustar prefixes, PAX extended headers (path/linkpath/size) and GNU
 * long name/link entries. OCI whiteouts (`.wh.<name>`, `.wh..wh..opq`) are
 * kept as entries — `mergeLayerEntries` (view.ts) interprets them.
 */

export type LayerEntryType = 'file' | 'dir' | 'symlink' | 'hardlink';

export interface LayerEntry {
  /** Normalized absolute path inside the layer ('/etc/os-release'). */
  path: string;
  type: LayerEntryType;
  /** File size in bytes (0 for dirs/links). */
  size: number;
  /** Offset of the entry's data inside the uncompressed tar. */
  offset: number;
  mode: number;
  mtimeMs: number;
  /** Symlink target or hardlink target path (absolute for hardlinks). */
  linkTarget?: string;
}

/** Published layer-index artifact (plan Phase 4; Phase 6.6's hydration substrate). */
export const LAYER_INDEX_MEDIA_TYPE = 'application/vnd.artipod.layer.index.v1+json';

export interface LayerIndexArtifact {
  formatVersion: 1;
  mediaType: typeof LAYER_INDEX_MEDIA_TYPE;
  entries: LayerEntry[];
}

const BLOCK = 512;
const decoder = new TextDecoder();

function readString(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return decoder.decode(nul === -1 ? slice : slice.subarray(0, nul));
}

/** Octal or GNU base-256 numeric field. */
function readNumber(bytes: Uint8Array, offset: number, length: number): number {
  if (bytes[offset] & 0x80) {
    // base-256: big-endian with the top bit of the first byte set
    let value = bytes[offset] & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i];
    return value;
  }
  const text = readString(bytes, offset, length).trim();
  return text ? parseInt(text, 8) : 0;
}

function normalizeTarPath(name: string): string {
  let p = name.replace(/\/+$/, '');
  if (p.startsWith('./')) p = p.slice(2);
  if (p === '.' || p === '') return '/';
  return p.startsWith('/') ? p : `/${p}`;
}

function parsePax(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < content.length) {
    const space = content.indexOf(' ', i);
    if (space === -1) break;
    const total = parseInt(content.slice(i, space), 10);
    if (!Number.isFinite(total) || total <= 0) break;
    const record = content.slice(space + 1, i + total - 1); // strip trailing \n
    const eq = record.indexOf('=');
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += total;
  }
  return out;
}

const isZeroBlock = (bytes: Uint8Array, offset: number): boolean => {
  for (let i = 0; i < BLOCK; i++) if (bytes[offset + i] !== 0) return false;
  return true;
};

/** Parse an uncompressed tar into layer entries (offsets into `bytes`). */
export function indexTar(bytes: Uint8Array): LayerEntry[] {
  const entries: LayerEntry[] = [];
  let offset = 0;
  let paxOverrides: Record<string, string> | null = null;
  let gnuLongName: string | null = null;
  let gnuLongLink: string | null = null;
  let globalPax: Record<string, string> = {};

  while (offset + BLOCK <= bytes.length) {
    if (isZeroBlock(bytes, offset)) break; // end-of-archive

    const rawName = readString(bytes, offset, 100);
    const mode = readNumber(bytes, offset + 100, 8);
    const size = readNumber(bytes, offset + 124, 12);
    const mtimeMs = readNumber(bytes, offset + 136, 12) * 1000;
    const typeflag = String.fromCharCode(bytes[offset + 156] || 0x30);
    const linkname = readString(bytes, offset + 157, 100);
    const magic = readString(bytes, offset + 257, 6);
    const prefix = magic.startsWith('ustar') ? readString(bytes, offset + 345, 155) : '';

    const dataOffset = offset + BLOCK;
    const dataEnd = dataOffset + size;
    const nextOffset = dataOffset + Math.ceil(size / BLOCK) * BLOCK;

    switch (typeflag) {
      case 'x': // PAX per-file
        paxOverrides = { ...globalPax, ...parsePax(decoder.decode(bytes.subarray(dataOffset, dataEnd))) };
        break;
      case 'g': // PAX global
        globalPax = { ...globalPax, ...parsePax(decoder.decode(bytes.subarray(dataOffset, dataEnd))) };
        break;
      case 'L': // GNU long name
        gnuLongName = readString(bytes, dataOffset, size);
        break;
      case 'K': // GNU long linkname
        gnuLongLink = readString(bytes, dataOffset, size);
        break;
      default: {
        const pax = paxOverrides ?? globalPax;
        const name = pax.path ?? gnuLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
        const link = pax.linkpath ?? gnuLongLink ?? linkname;
        const realSize = pax.size !== undefined ? parseInt(pax.size, 10) : size;
        const path = normalizeTarPath(name);

        if (path !== '/') {
          if (typeflag === '5') {
            entries.push({ path, type: 'dir', size: 0, offset: dataOffset, mode, mtimeMs });
          } else if (typeflag === '2') {
            entries.push({ path, type: 'symlink', size: 0, offset: dataOffset, mode, mtimeMs, linkTarget: link });
          } else if (typeflag === '1') {
            entries.push({
              path,
              type: 'hardlink',
              size: 0,
              offset: dataOffset,
              mode,
              mtimeMs,
              linkTarget: normalizeTarPath(link),
            });
          } else if (typeflag === '0' || typeflag === '' || typeflag === '\0' || typeflag === '7') {
            entries.push({ path, type: 'file', size: realSize, offset: dataOffset, mode, mtimeMs });
          }
          // char/block devices and fifos are dropped: not representable in pods
        }
        paxOverrides = null;
        gnuLongName = null;
        gnuLongLink = null;
      }
    }
    offset = nextOffset;
  }
  return entries;
}

export function makeLayerIndexArtifact(entries: LayerEntry[]): LayerIndexArtifact {
  return { formatVersion: 1, mediaType: LAYER_INDEX_MEDIA_TYPE, entries };
}

export function parseLayerIndexArtifact(json: string): LayerIndexArtifact {
  const parsed = JSON.parse(json) as LayerIndexArtifact;
  if (parsed.formatVersion !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('Unsupported layer index artifact');
  }
  return parsed;
}

/** Whiteout helpers (OCI image spec). */
export const OPAQUE_MARKER = '.wh..wh..opq';
export function whiteoutTarget(path: string): { kind: 'opaque'; dir: string } | { kind: 'delete'; target: string } | null {
  const idx = path.lastIndexOf('/');
  const base = path.slice(idx + 1);
  const dir = idx <= 0 ? '/' : path.slice(0, idx);
  if (base === OPAQUE_MARKER) return { kind: 'opaque', dir };
  if (base.startsWith('.wh.')) return { kind: 'delete', target: dir === '/' ? `/${base.slice(4)}` : `${dir}/${base.slice(4)}` };
  return null;
}
