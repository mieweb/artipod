/**
 * Test fixtures: a minimal ustar writer (with optional PAX long-name
 * records) and gzip via CompressionStream — enough to craft layers and a
 * whole fake registry without any network or docker.
 */

export interface TarSpec {
  path: string;
  content?: string;
  type?: 'file' | 'dir' | 'symlink' | 'hardlink';
  linkTarget?: string;
  mode?: number;
  /** Force a PAX extended header carrying the path. */
  pax?: boolean;
}

const encoder = new TextEncoder();

function writeOctal(block: Uint8Array, offset: number, length: number, value: number) {
  const s = value.toString(8).padStart(length - 1, '0');
  block.set(encoder.encode(s), offset);
  block[offset + length - 1] = 0;
}

function header(name: string, size: number, typeflag: string, mode: number, linkname = ''): Uint8Array {
  const block = new Uint8Array(512);
  block.set(encoder.encode(name.slice(0, 100)), 0);
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block.set(encoder.encode('        '), 148); // checksum placeholder = spaces
  block[156] = typeflag.charCodeAt(0);
  block.set(encoder.encode(linkname.slice(0, 100)), 157);
  block.set(encoder.encode('ustar'), 257);
  block[262] = 0;
  block.set(encoder.encode('00'), 263);
  let sum = 0;
  for (const b of block) sum += b;
  const checksum = sum.toString(8).padStart(6, '0');
  block.set(encoder.encode(checksum), 148);
  block[154] = 0;
  block[155] = 0x20;
  return block;
}

function pad512(n: number): number {
  return Math.ceil(n / 512) * 512;
}

export function makeTar(specs: TarSpec[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const spec of specs) {
    const type = spec.type ?? 'file';
    const content = spec.content !== undefined ? encoder.encode(spec.content) : new Uint8Array(0);
    const mode = spec.mode ?? (type === 'dir' ? 0o755 : 0o644);

    if (spec.pax) {
      const record = `path=${spec.path}\n`;
      // PAX record length includes its own length field
      let len = record.length + 3;
      if (`${len} ${record}`.length !== len) len += 1;
      const paxContent = encoder.encode(`${len} ${record}`);
      parts.push(header('././@PaxHeader', paxContent.length, 'x', 0o644));
      const padded = new Uint8Array(pad512(paxContent.length));
      padded.set(paxContent);
      parts.push(padded);
    }

    const typeflag = type === 'dir' ? '5' : type === 'symlink' ? '2' : type === 'hardlink' ? '1' : '0';
    const name = spec.pax ? 'truncated' : spec.path;
    parts.push(header(name, content.length, typeflag, mode, spec.linkTarget ?? ''));
    if (content.length) {
      const padded = new Uint8Array(pad512(content.length));
      padded.set(content);
      parts.push(padded);
    }
  }
  parts.push(new Uint8Array(1024)); // end-of-archive
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
