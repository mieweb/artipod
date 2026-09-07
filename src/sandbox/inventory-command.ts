/**
 * `images`, `lsblk`, `mount` — and a pod-less `artipod` dispatcher for
 * consoles that have no pod (the catalog). Inside a pod shell the real
 * `artipod` verb gains `images` / `lsblk` through the same renderers.
 */
import { defineCommand } from 'just-bash/browser';
import type { ExecResult } from 'just-bash/browser';
import { shortDigest, type ImageDetail, type ImageRow, type InventoryProviders, type VolumeRow } from '../proc/inventory.js';
import type { ProcessTable } from '../proc/processes.js';
import { renderTable } from './table.js';
import { verbTree, withCompletion } from './types.js';

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ stdout: '', stderr, exitCode });

const USAGE = {
  images: `usage: images [-v [<ref>]]

Refs on the server — what this machine can open or run. Same rows as the
catalog's "On this server" list. -v adds, under each image, where its bytes
live (browser-local store path, the .alias twin an encrypted store keeps,
the server URL) and the layer tree: one layer per file, newest last, with
the actor and time that wrote it. Big pods show only the top of the stack;
\`images -v <ref>\` shows one image in full. Also: artipod images.
`,
  lsblk: `usage: lsblk [-m]

Local workspaces: blank scratch trees, copy-on-write forks and opened refs.
They exist whether or not a tab has them open; MOUNTPOINT is set only while
one does (-m: mounted only; \`mount\` is the same). Also: artipod lsblk.
`,
};

export function renderImages(rows: ImageRow[]): string {
  if (rows.length === 0) return 'no images on the server\n';
  const split = (ref: string) => {
    const i = ref.lastIndexOf(':');
    return i === -1 ? [ref, '-'] : [ref.slice(0, i), ref.slice(i + 1)];
  };
  return renderTable(
    ['REPOSITORY', 'TAG', 'DIGEST', 'ENCRYPTION', 'LOCKED', 'STATUS'],
    rows.map((r) => [...split(r.ref), shortDigest(r.digest), r.encryption ?? '-', r.locked ? 'yes' : '-', r.status ?? '-']),
  );
}

const human = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`;
const when = (ms?: number): string => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '');

/** The indented block `images -v` prints under one image row. */
export function renderImageDetail(image: ImageRow, detail: ImageDetail | null, maxLayers = Infinity): string {
  const out: string[] = [`${image.ref}  @${shortDigest(image.digest)}  ${image.encryption ?? ''}`.trimEnd()];
  if (!detail) { out.push('    (no detail available)'); return `${out.join('\n')}\n`; }
  out.push(`    local   ${detail.localPath}${detail.localPresent ? '' : '   (not pulled — open the workspace to fetch it)'}`);
  if (detail.aliasPath) out.push(`    alias   ${detail.aliasPath}   (plaintext digest → ciphertext digest; the blob is ciphertext)`);
  if (detail.remoteUrl) out.push(`    remote  ${detail.remoteUrl}`);
  if (detail.parents.length) out.push(`    parents ${detail.parents.map(shortDigest).join(', ')}   (previous head${detail.parents.length > 1 ? 's' : ''} — the tag's history)`);
  if (detail.unavailable) { out.push(`    layers  ${detail.unavailable}`); return `${out.join('\n')}\n`; }
  const total = detail.layers.reduce((n, l) => n + l.size, 0);
  out.push(`    layers  ${detail.layers.length} · ${human(total)}${detail.actor ? ` · by ${detail.actor}` : ''}   (bottom → top; later layers win)`);
  // Big pods (hundreds of per-file layers): show the top of the stack, point at the full view.
  const shown = detail.layers.length > maxLayers ? detail.layers.slice(-maxLayers) : detail.layers;
  const hidden = detail.layers.length - shown.length;
  const offset = hidden;
  const width = Math.max(0, ...shown.map((l) => (l.path ?? '').length));
  if (hidden > 0) out.push(`    │   … ${hidden} older layer${hidden === 1 ? '' : 's'} (images -v ${image.ref} shows all)`);
  shown.forEach((layer, i) => {
    const last = i === shown.length - 1;
    const meta = [when(layer.mtimeMs), layer.actor, layer.overlay ? '(overlay)' : ''].filter(Boolean).join('  ');
    out.push(`    ${last ? '└─' : '├─'} ${String(offset + i + 1).padStart(String(detail.layers.length).length)}  ${shortDigest(layer.digest)}  ${human(layer.size).padStart(8)}  ${(layer.path ?? '').padEnd(width)}  ${meta}`.trimEnd());
  });
  return `${out.join('\n')}\n`;
}

const LISTING_LAYERS = 8;

export async function renderImagesVerbose(providers: InventoryProviders, only?: string): Promise<string> {
  const rows = (await providers.images?.()) ?? [];
  if (rows.length === 0) return 'no images on the server\n';
  if (only) {
    const row = rows.find((r) => r.ref === only);
    if (!row) throw new Error(`no such image: ${only}`);
    return renderImageDetail(row, providers.imageDetail ? await providers.imageDetail(row.ref) : null);
  }
  const blocks: string[] = [];
  for (const row of rows) blocks.push(renderImageDetail(row, providers.imageDetail ? await providers.imageDetail(row.ref) : null, LISTING_LAYERS));
  return blocks.join('\n');
}

export function renderVolumes(rows: VolumeRow[], mountedOnly = false): string {
  const shown = mountedOnly ? rows.filter((r) => r.mountpoint) : rows;
  if (shown.length === 0) return mountedOnly ? 'nothing mounted — no workspace is open in any tab\n' : 'no local workspaces yet\n';
  return renderTable(
    ['NAME', 'TYPE', 'MODE', 'ENCRYPTION', 'STATE', 'MOUNTPOINT'],
    shown.map((r) => [r.name, r.type, r.mode ?? '-', r.encryption ?? '-', r.state ?? '-', r.mountpoint ?? '']),
  );
}

const help = (name: keyof typeof USAGE, args: string[]) =>
  args.includes('--help') || args.includes('-h') ? ok(USAGE[name]) : null;

export function makeInventoryCommands(providers: InventoryProviders) {
  const images = withCompletion(defineCommand('images', async (args) => {
    const h = help('images', args); if (h) return h;
    if (!providers.images) return fail('images: no server catalog in this context\n');
    if (args.includes('-v')) {
      try { return ok(await renderImagesVerbose(providers, args.find((a) => !a.startsWith('-')))); }
      catch (e) { return fail(`images: ${(e as Error).message}\n`); }
    }
    return ok(renderImages(await providers.images()));
  }), async (args, token) => token.startsWith('-') || args.length === 0 ? ['-v'] : ((await providers.images?.()) ?? []).map((r) => r.ref));
  const lsblk = withCompletion(defineCommand('lsblk', async (args) => {
    const h = help('lsblk', args); if (h) return h;
    if (!providers.volumes) return fail('lsblk: no workspace registry in this context\n');
    return ok(renderVolumes(await providers.volumes(), args.includes('-m')));
  }), () => ['-m']);
  const mount = defineCommand('mount', async (args) => {
    const h = help('lsblk', args); if (h) return h;
    if (!providers.volumes) return fail('mount: no workspace registry in this context\n');
    return ok(renderVolumes(await providers.volumes(), true));
  });
  return [images, lsblk, mount];
}

const CONSOLE_USAGE = `usage: artipod <images|lsblk|ps> …
  images        refs on the server (same as the bare \`images\`)
  lsblk         local workspaces and whether a tab has them mounted
  ps            processes in this console's namespace

This console has no pod open. Pod verbs (image, snapshot, commit, push,
publish, login, …) live in a workspace shell — open one from the catalog.
`;

/** `artipod` for consoles without a pod: inventory + processes only. */
export function makeConsoleArtipodCommand(providers: InventoryProviders, processes?: ProcessTable) {
  return withCompletion(defineCommand('artipod', async (args) => {
    const [group] = args;
    if (!group || group === '--help' || group === '-h' || group === 'help') return ok(CONSOLE_USAGE);
    if (group === 'images') {
      if (!providers.images) return fail('artipod images: no server catalog in this context\n');
      if (args.includes('-v')) {
        try { return ok(await renderImagesVerbose(providers, args.slice(1).find((a) => !a.startsWith('-')))); }
        catch (e) { return fail(`artipod images: ${(e as Error).message}\n`); }
      }
      return ok(renderImages(await providers.images()));
    }
    if (group === 'lsblk') {
      if (!providers.volumes) return fail('artipod lsblk: no workspace registry in this context\n');
      return ok(renderVolumes(await providers.volumes(), args.includes('-m')));
    }
    if (group === 'ps') {
      if (!processes) return fail('artipod ps: no process table in this context\n');
      return ok(renderTable(['PID', 'KIND', 'STATE', 'NAME'], processes.list().map((p) => [String(p.pid), p.kind, p.state, p.name]), [0]));
    }
    return fail(`artipod: '${group}' needs an open pod — this console has none\n${CONSOLE_USAGE}`);
  }), verbTree({ images: { '-v': {} }, lsblk: { '-m': {} }, ps: {}, help: {} }));
}
