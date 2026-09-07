/**
 * `images`, `lsblk`, `mount` — and a pod-less `artipod` dispatcher for
 * consoles that have no pod (the catalog). Inside a pod shell the real
 * `artipod` verb gains `images` / `lsblk` through the same renderers.
 */
import { defineCommand } from 'just-bash/browser';
import type { ExecResult } from 'just-bash/browser';
import { shortDigest, type ImageDetail, type ImageRow, type InventoryProviders, type LayerRow, type VolumeRow } from '../proc/inventory.js';
import type { ProcessTable } from '../proc/processes.js';
import { renderTable } from './table.js';
import { withCompletion } from './types.js';

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ stdout: '', stderr, exitCode });

const USAGE = {
  images: `usage: images [-v | -vv] [<ref>] [--json]

Refs on the server — what this machine can open or run. Same rows as the
catalog's "On this server" list. Also: artipod images.

  -v      under each image: where its bytes live (browser-local store path,
          the .alias twin an encrypted store keeps, the server URL), the
          parents, a one-line layer summary with hydration counts, and what
          changed since the parent (the image's "git show --stat").
  -vv     the full layer stack, bottom → top, each marked ● local / ☁︎ lazy.
          Layers are per file (D17): one OCI layer per file, so the stack
          reads as who wrote which file, when. -v <ref> implies -vv.
  --json  JSON Lines, one ImageRow per line; with -v/-vv <ref>, one ImageDetail.
`,
  lsblk: `usage: lsblk [-m] [--json]

Local workspaces: blank scratch trees, copy-on-write forks and opened refs.
They exist whether or not a tab has them open; MOUNTPOINT is set only while
one does (-m: mounted only; \`mount\` is the same). --json: JSON Lines, one
VolumeRow per line. Also: artipod lsblk.
`,
};

/** Shared flag parsing for the three `images` entry points. */
export function imagesArgs(args: string[]): { level: 0 | 1 | 2; json: boolean; ref?: string } {
  const level = args.includes('-vv') ? 2 : args.includes('-v') ? 1 : 0;
  return { level, json: args.includes('--json'), ref: args.find((a) => !a.startsWith('-')) };
}

export const jsonLines = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');

export async function runImages(providers: InventoryProviders, args: string[], prefix = 'images'): Promise<ExecResult> {
  if (!providers.images) return fail(`${prefix}: no server catalog in this context\n`);
  const { level, json, ref } = imagesArgs(args);
  try {
    if (json) {
      if (level && ref) {
        if (!((await providers.images()).some((r) => r.ref === ref))) throw new Error(`no such image: ${ref}`);
        return ok(`${JSON.stringify(await providers.imageDetail?.(ref) ?? null)}\n`);
      }
      return ok(jsonLines(await providers.images()));
    }
    if (level) return ok(await renderImagesVerbose(providers, level === 2, ref));
    return ok(renderImages(await providers.images()));
  } catch (e) {
    return fail(`${prefix}: ${(e as Error).message}\n`);
  }
}

export async function runVolumes(providers: InventoryProviders, args: string[], prefix = 'lsblk', mountedOnly = false): Promise<ExecResult> {
  if (!providers.volumes) return fail(`${prefix}: no workspace registry in this context\n`);
  const rows = await providers.volumes();
  const only = mountedOnly || args.includes('-m');
  if (args.includes('--json')) return ok(jsonLines(only ? rows.filter((r) => r.mountpoint) : rows));
  return ok(renderVolumes(rows, only));
}

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
const mark = (layer: LayerRow): string => (layer.local === undefined ? ' ' : layer.local ? '●' : '☁︎');

function renderLayerRows(layers: LayerRow[], total: number, offset = 0): string[] {
  const width = Math.max(0, ...layers.map((l) => (l.path ?? '').length));
  const digits = String(total).length;
  return layers.map((layer, i) => {
    const last = i === layers.length - 1;
    const meta = [when(layer.mtimeMs), layer.actor, layer.overlay ? '(overlay)' : ''].filter(Boolean).join('  ');
    return `    ${last ? '└─' : '├─'} ${String(offset + i + 1).padStart(digits)} ${mark(layer)} ${shortDigest(layer.digest)}  ${human(layer.size).padStart(8)}  ${(layer.path ?? '').padEnd(width)}  ${meta}`.trimEnd();
  });
}

/**
 * The indented block under one image row. `full` = every layer with its
 * hydration mark (-vv); otherwise a summary line plus what changed since the
 * parent (-v). Per-file layers are the artipod convention (D17): one OCI
 * layer per file, so "changed since parent" is a real diff, not a guess.
 */
export function renderImageDetail(image: ImageRow, detail: ImageDetail | null, full = false): string {
  const out: string[] = [`${image.ref}  @${shortDigest(image.digest)}  ${image.encryption ?? ''}`.trimEnd()];
  if (!detail) { out.push('    (no detail available)'); return `${out.join('\n')}\n`; }
  out.push(`    local   ${detail.localPath}${detail.localPresent ? '' : '   (not pulled — open the workspace to fetch it)'}`);
  if (detail.aliasPath) out.push(`    alias   ${detail.aliasPath}   (plaintext digest → ciphertext digest; the blob is ciphertext)`);
  if (detail.remoteUrl) out.push(`    remote  ${detail.remoteUrl}`);
  if (detail.parents.length) out.push(`    parents ${detail.parents.map(shortDigest).join(', ')}   (previous head${detail.parents.length > 1 ? 's' : ''} — the tag's history)`);
  if (detail.unavailable) { out.push(`    layers  ${detail.unavailable}`); return `${out.join('\n')}\n`; }
  const total = detail.layers.reduce((n, l) => n + l.size, 0);
  const known = detail.layers.filter((l) => l.local !== undefined);
  const hydrated = known.filter((l) => l.local).length;
  const hydration = known.length ? ` · ${hydrated} local ● ${known.length - hydrated} lazy ☁︎` : '';
  out.push(`    layers  ${detail.layers.length} file layer${detail.layers.length === 1 ? '' : 's'} · ${human(total)}${hydration}${detail.actor ? ` · by ${detail.actor}` : ''}`);
  if (full) {
    out.push('    │   bottom → top; later layers win');
    out.push(...renderLayerRows(detail.layers, detail.layers.length));
    return `${out.join('\n')}\n`;
  }
  if (detail.changed) {
    if (detail.changed.length === 0) out.push(`    changed nothing since ${shortDigest(detail.parents[0])}   (same layer set — a re-push with no edits)`);
    else {
      out.push(`    changed ${detail.changed.length} file layer${detail.changed.length === 1 ? '' : 's'} since ${shortDigest(detail.parents[0])}:`);
      out.push(...renderLayerRows(detail.changed, detail.changed.length));
    }
  } else if (detail.parents.length) {
    out.push(`    changed (parent ${shortDigest(detail.parents[0])} is not readable here — not pulled and not on this server; images -vv ${image.ref} lists all layers)`);
  } else {
    out.push(`    changed (no parent — first head of this tag; images -vv ${image.ref} lists all layers)`);
  }
  return `${out.join('\n')}\n`;
}

export async function renderImagesVerbose(providers: InventoryProviders, full: boolean, only?: string): Promise<string> {
  const rows = (await providers.images?.()) ?? [];
  if (rows.length === 0) return 'no images on the server\n';
  const pick = only ? rows.filter((r) => r.ref === only) : rows;
  if (only && pick.length === 0) throw new Error(`no such image: ${only}`);
  const blocks: string[] = [];
  for (const row of pick) blocks.push(renderImageDetail(row, providers.imageDetail ? await providers.imageDetail(row.ref) : null, full || !!only));
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
  const imageCompleter = async (args: string[], token: string) =>
    token.startsWith('-') || args.length === 0 ? ['-v', '-vv', '--json'] : ((await providers.images?.()) ?? []).map((r) => r.ref);
  const images = withCompletion(defineCommand('images', async (args) => {
    const h = help('images', args); if (h) return h;
    return runImages(providers, args);
  }), imageCompleter);
  const lsblk = withCompletion(defineCommand('lsblk', async (args) => {
    const h = help('lsblk', args); if (h) return h;
    return runVolumes(providers, args);
  }), () => ['-m', '--json']);
  const mount = withCompletion(defineCommand('mount', async (args) => {
    const h = help('lsblk', args); if (h) return h;
    return runVolumes(providers, args, 'mount', true);
  }), () => ['--json']);
  return [images, lsblk, mount];
}

const CONSOLE_USAGE = `usage: artipod <images|lsblk|ps> …
  images [-v|-vv] [<ref>] [--json]   refs on the server (same as the bare \`images\`)
  lsblk [-m] [--json]                local workspaces and whether a tab has them mounted
  ps [--json]                        processes in this console's namespace

This console has no pod open. Pod verbs (image, snapshot, commit, push,
publish, login, …) live in a workspace shell — open one from the catalog.
`;

/** `artipod` for consoles without a pod: inventory + processes only. */
export function makeConsoleArtipodCommand(providers: InventoryProviders, processes?: ProcessTable) {
  return withCompletion(defineCommand('artipod', async (args) => {
    const [group, ...rest] = args;
    if (!group || group === '--help' || group === '-h' || group === 'help') return ok(CONSOLE_USAGE);
    if (group === 'images') return runImages(providers, rest, 'artipod images');
    if (group === 'lsblk') return runVolumes(providers, rest, 'artipod lsblk');
    if (group === 'ps') {
      if (!processes) return fail('artipod ps: no process table in this context\n');
      if (rest.includes('--json')) return ok(jsonLines(processes.list()));
      return ok(renderTable(['PID', 'KIND', 'STATE', 'NAME'], processes.list().map((p) => [String(p.pid), p.kind, p.state, p.name]), [0]));
    }
    return fail(`artipod: '${group}' needs an open pod — this console has none\n${CONSOLE_USAGE}`);
  }), async (args, token) => {
    if (args.length === 0) return ['help', 'images', 'lsblk', 'ps'];
    if (args[0] === 'images') return token.startsWith('-') || args.length === 1 ? ['-v', '-vv', '--json'] : ((await providers.images?.()) ?? []).map((r) => r.ref);
    if (args[0] === 'lsblk') return ['-m', '--json'];
    if (args[0] === 'ps') return ['--json'];
    return [];
  });
}
