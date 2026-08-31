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

/** Turn a path into its whiteout marker path (deletion entry for diff layers). */
export function whiteoutPathFor(path: string): string {
  const idx = path.lastIndexOf('/');
  const dir = idx <= 0 ? '' : path.slice(0, idx);
  return `${dir}/.wh.${path.slice(idx + 1)}`;
}

// --- tar writer (diff/commit layers) ----------------------------------------

export interface TarWriteEntry {
  path: string;
  type: LayerEntryType;
  content?: Uint8Array;
  mode?: number;
  mtimeMs?: number;
  linkTarget?: string;
}

const tarEncoder = new TextEncoder();

function writeOctal(block: Uint8Array, offset: number, length: number, value: number) {
  const s = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  block.set(tarEncoder.encode(s.slice(0, length - 1)), offset);
  block[offset + length - 1] = 0;
}

function tarHeader(name: string, size: number, typeflag: string, mode: number, mtimeMs: number, linkname = ''): Uint8Array {
  const block = new Uint8Array(512);
  block.set(tarEncoder.encode(name.slice(0, 100)), 0);
  writeOctal(block, 100, 8, mode & 0o7777);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, Math.floor(mtimeMs / 1000));
  block.set(tarEncoder.encode('        '), 148);
  block[156] = typeflag.charCodeAt(0);
  block.set(tarEncoder.encode(linkname.slice(0, 100)), 157);
  block.set(tarEncoder.encode('ustar'), 257);
  block.set(tarEncoder.encode('00'), 263);
  let sum = 0;
  for (const b of block) sum += b;
  block.set(tarEncoder.encode(sum.toString(8).padStart(6, '0')), 148);
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

/**
 * Write a tar (PAX long-name records when needed). Paths are pod-absolute
 * and stored without the leading slash, the way image layers ship.
 */
export function writeTar(entries: TarWriteEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const pad512 = (n: number) => Math.ceil(n / 512) * 512;
  for (const entry of entries) {
    const name = entry.path.replace(/^\//, '') + (entry.type === 'dir' ? '/' : '');
    const content = entry.content ?? new Uint8Array(0);
    const mtimeMs = entry.mtimeMs ?? 0;
    const mode = entry.mode ?? (entry.type === 'dir' ? 0o755 : 0o644);
    if (name.length > 100) {
      const record = `path=${name}\n`;
      let len = record.length + 3;
      if (`${len} ${record}`.length !== len) len += 1;
      const pax = tarEncoder.encode(`${len} ${record}`);
      parts.push(tarHeader('././@PaxHeader', pax.length, 'x', 0o644, mtimeMs));
      const padded = new Uint8Array(pad512(pax.length));
      padded.set(pax);
      parts.push(padded);
    }
    const typeflag = entry.type === 'dir' ? '5' : entry.type === 'symlink' ? '2' : entry.type === 'hardlink' ? '1' : '0';
    parts.push(tarHeader(name.length > 100 ? name.slice(0, 100) : name, entry.type === 'file' ? content.length : 0, typeflag, mode, mtimeMs, entry.linkTarget ?? ''));
    if (entry.type === 'file' && content.length) {
      const padded = new Uint8Array(pad512(content.length));
      padded.set(content);
      parts.push(padded);
    }
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
