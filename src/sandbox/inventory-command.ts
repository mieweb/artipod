/**
 * `images`, `lsblk`, `mount` — and a pod-less `artipod` dispatcher for
 * consoles that have no pod (the catalog). Inside a pod shell the real
 * `artipod` verb gains `images` / `lsblk` through the same renderers.
 */
import { defineCommand } from 'just-bash/browser';
import type { ExecResult } from 'just-bash/browser';
import { shortDigest, type ImageRow, type InventoryProviders, type VolumeRow } from '../proc/inventory.js';
import type { ProcessTable } from '../proc/processes.js';
import { renderTable } from './table.js';
import { verbTree, withCompletion } from './types.js';

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ stdout: '', stderr, exitCode });

const USAGE = {
  images: `usage: images

Refs on the server — what this machine can open or run. Same rows as the
catalog's "On this server" list. Also: artipod images.
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
  const images = defineCommand('images', async (args) => {
    const h = help('images', args); if (h) return h;
    if (!providers.images) return fail('images: no server catalog in this context\n');
    return ok(renderImages(await providers.images()));
  });
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
  }), verbTree({ images: {}, lsblk: { '-m': {} }, ps: {}, help: {} }));
}
