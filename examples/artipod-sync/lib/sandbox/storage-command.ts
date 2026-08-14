/**
 * `mount`, `df`, `findmnt`, `lsblk`, `fdisk -l`, `diskutil list` — read-only
 * views of the browser storage layer, all rendered from one `probeStorage()`.
 *
 * The block-device framing is deliberate and accurate: the ORIGIN is the disk
 * (one quota shared by every backend) and IndexedDB / OPFS are partitions on
 * it. So per-device rows report Used only; Size and Avail exist on the origin.
 * Anything unknown prints `-` rather than a made up number.
 *
 * Used bytes come from `navigator.storage.estimate().usageDetails` (Chromium
 * only) or, with `df --scan`, from walking the mounted tree.
 */
import { defineCommand } from 'just-bash/browser';
import type { ExecResult } from 'just-bash/browser';
import {
  backendAt,
  getStorageUsage,
  mountBackend,
  opfsDirBytes,
  unmountBackend,
  OPFS_FS_DIR,
  OPFS_MODELS_DIR,
  type MountSpec,
} from './storage';
import { renderTable } from './table';
import type { ZenFsLike } from './types';

export interface StorageDevice {
  /** Block-device-ish name for the lsblk/fdisk views, e.g. `idb0`. */
  name: string;
  /** df's "Filesystem" column, e.g. `indexeddb:browser-git-fs`. */
  source: string;
  type: 'indexeddb' | 'opfs' | 'memory';
  label: string;
  uuid: string | null;
  /** ZenFS mount point, or null for a device that exists but is not mounted. */
  mountPoint: string | null;
  options: string[];
  /** Apparent bytes, or null when the browser won't tell us. */
  used: number | null;
}

export interface StorageOrigin {
  host: string;
  usage: number;
  quota: number;
  persisted: boolean;
}

export interface StorageReport {
  devices: StorageDevice[];
  origin: StorageOrigin | null;
}

/**
 * ZenFS names a StoreFS after its store, so an IndexedDB mount surfaces as its
 * object-store name; only the in-memory and OPFS backends have fixed names.
 */
function deviceType(fsName: string): StorageDevice['type'] {
  if (fsName === 'webaccessfs') return 'opfs';
  if (fsName === 'tmpfs') return 'memory';
  return 'indexeddb';
}

const NAME_PREFIX: Record<StorageDevice['type'], string> = {
  indexeddb: 'idb',
  opfs: 'opfs',
  memory: 'mem',
};

export async function probeStorage(opts: {
  scan?: boolean;
  zfs?: ZenFsLike;
}): Promise<StorageReport> {
  const { mounts } = await import('@zenfs/core');
  const usage = await getStorageUsage();
  const modelBytes = await opfsDirBytes(OPFS_MODELS_DIR);

  const devices: StorageDevice[] = [];
  mounts.forEach((fs, mountPoint) => {
    const type = deviceType(fs.name);
    const label = type === 'opfs' ? OPFS_FS_DIR : fs.name;
    devices.push({
      name: '',
      source: type === 'memory' ? 'tmpfs' : `${type}:${label}`,
      type,
      label,
      uuid: fs.uuid ?? null,
      mountPoint,
      options: ['rw', ...(usage?.persisted ? ['persisted'] : [])],
      used: backendBytes(type, usage?.details, modelBytes),
    });
  });
  devices.sort((a, b) => (a.mountPoint ?? '').localeCompare(b.mountPoint ?? ''));

  // Data left behind by the other backend still counts against the quota.
  if (!devices.some((d) => d.type === 'opfs') && (await opfsDirBytes(OPFS_FS_DIR)) !== null) {
    devices.push({
      name: '',
      source: `opfs:${OPFS_FS_DIR}`,
      type: 'opfs',
      label: OPFS_FS_DIR,
      uuid: null,
      mountPoint: null,
      options: ['unmounted'],
      used: backendBytes('opfs', usage?.details, modelBytes),
    });
  }

  if (modelBytes !== null) {
    devices.push({
      name: '',
      source: `opfs:${OPFS_MODELS_DIR}`,
      type: 'opfs',
      label: OPFS_MODELS_DIR,
      uuid: null,
      mountPoint: null,
      options: ['ro', 'host'],
      used: modelBytes,
    });
  }

  const counters: Record<string, number> = {};
  for (const device of devices) {
    const prefix = NAME_PREFIX[device.type];
    device.name = `${prefix}${counters[prefix] ?? 0}`;
    counters[prefix] = (counters[prefix] ?? 0) + 1;
  }

  if (opts.scan && opts.zfs) {
    const zfs = opts.zfs;
    const mountPoints = devices.map((d) => d.mountPoint).filter((p): p is string => p !== null);
    for (const device of devices) {
      if (device.mountPoint) device.used = await treeBytes(zfs, device.mountPoint, mountPoints);
    }
  }

  return {
    devices,
    origin: usage
      ? { host: typeof location === 'undefined' ? 'browser' : location.hostname, ...usage }
      : null,
  };
}

function backendBytes(
  type: StorageDevice['type'],
  details: Record<string, number> | undefined,
  modelBytes: number | null,
): number | null {
  if (type === 'memory') return null;
  if (type === 'indexeddb') return details?.indexedDB ?? null;
  const opfs = details?.fileSystem;
  return opfs === undefined ? null : Math.max(0, opfs - (modelBytes ?? 0));
}

/** Apparent size of a subtree, skipping paths owned by a nested mount. */
async function treeBytes(zfs: ZenFsLike, root: string, allMounts: string[]): Promise<number> {
  const nested = allMounts.filter((m) => m !== root && m.startsWith(root === '/' ? '/' : `${root}/`));
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const name of await zfs.promises.readdir(dir)) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      if (nested.includes(path)) continue;
      const st = await zfs.promises.lstat(path);
      if (st.isDirectory()) await walk(path);
      else bytes += st.size;
    }
  };
  await walk(root);
  return bytes;
}

const mounted = (devices: StorageDevice[]) => devices.filter((d) => d.mountPoint);

const QUOTA_NOTE = `The browser gives ONE storage quota to the whole origin, shared by every
backend, so per-device Size/Avail is reported as '-' and only the origin
row carries real capacity. Used is a browser estimate (Chromium only).
`;

const USAGE: Record<string, string> = {
  mount: `usage: mount
       mount -t <type> [-o <options>] <dir>

With no arguments, list the ZenFS mount points in /etc/mtab style.

One VFS is *the* filesystem; IndexedDB and OPFS are interchangeable backing
devices that can be attached anywhere in it, side by side.

  -t memory              a fresh in-memory filesystem (tmpfs)
  -t idb [-o store=NAME] an IndexedDB object store (default store: artipodfs)
  -t opfs [-o dir=PATH]  the OPFS sandbox dir, or a subdirectory of it

The mount point is created if it does not exist.
`,
  umount: `usage: umount [-f] <dir>

Detach a filesystem. / and /proc are never unmountable; a device holding
persistent data (IndexedDB, OPFS) needs -f, since unmounting it hides data
that is still there.
`,
  df: `usage: df [-h] [-k] [-T] [--scan] [path...]

  -h        human-readable sizes
  -k        1K blocks (default)
  -T        add a filesystem Type column
  --scan    walk the tree for exact Used bytes instead of the browser estimate
  --help    this message

-v -P -l -a --sync --no-sync --local are accepted and ignored, as in real df.

${QUOTA_NOTE}`,
  findmnt: `usage: findmnt

List the mounted filesystems as TARGET / SOURCE / FSTYPE / OPTIONS.
`,
  lsblk: `usage: lsblk [-f]

  -f   show FSTYPE, LABEL, UUID and FSUSE% instead of SIZE and TYPE

The origin quota is the disk; each storage backend is a partition on it.
${QUOTA_NOTE}`,
  fdisk: `usage: fdisk -l

Print the origin quota as a disk with each storage backend as a partition.
Read-only: partitioning is not supported.
${QUOTA_NOTE}`,
  diskutil: `usage: diskutil list

Print the origin quota and its storage backends in diskutil's format.
Read-only: only 'list' is supported.
${QUOTA_NOTE}`,
};

/** `--help` everywhere, plus `-h` where df hasn't already claimed it. */
function helpFor(name: string, args: string[], shortFlag = true): ExecResult | null {
  const flags = expandFlags(args);
  if (flags.includes('--help') || (shortFlag && flags.includes('-h'))) {
    return { stdout: USAGE[name], stderr: '', exitCode: 0 };
  }
  return null;
}

const MOUNT_TYPES: Record<string, MountSpec['type']> = {
  memory: 'memory',
  mem: 'memory',
  tmpfs: 'memory',
  idb: 'indexeddb',
  indexeddb: 'indexeddb',
  opfs: 'opfs',
};

/** `-o store=x,dir=y` → `{ store: 'x', dir: 'y' }`. */
function parseMountOptions(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(',').filter(Boolean)) {
    const eq = part.indexOf('=');
    out[eq < 0 ? part : part.slice(0, eq)] = eq < 0 ? '' : part.slice(eq + 1);
  }
  return out;
}

/** Mount points the shell cannot function without. */
const PINNED_MOUNTS = new Set(['/', '/proc']);

const makeMountCommand = () =>
  defineCommand('mount', async (args, ctx) => {
    const help = helpFor('mount', args);
    if (help) return help;

    if (!args.length) {
      const { devices } = await probeStorage({});
      const lines = mounted(devices).map(
        (d) => `${d.source} on ${d.mountPoint} type ${d.type} (${d.options.join(',')})`,
      );
      return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
    }

    let type: string | undefined;
    let options: string | undefined;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-t') type = args[++i];
      else if (args[i] === '-o') options = args[++i];
      else rest.push(args[i]);
    }
    if (!type || rest.length !== 1) {
      return fail('mount', "usage: mount -t <type> [-o <options>] <dir> (try 'mount --help')");
    }
    const backend = MOUNT_TYPES[type];
    if (!backend) return fail('mount', `unknown filesystem type '${type}'`);

    const { store, dir } = parseMountOptions(options);
    const path = ctx.fs.resolvePath(ctx.cwd, rest[0]);
    try {
      await mountBackend(path, { type: backend, store: store || undefined, dir: dir || undefined });
    } catch (e) {
      return fail('mount', (e as Error).message);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

const makeUmountCommand = () =>
  defineCommand('umount', async (args, ctx) => {
    const help = helpFor('umount', args);
    if (help) return help;
    const flags = expandFlags(args);
    const force = flags.includes('-f') || flags.includes('--force');
    const target = flags.find((a) => !a.startsWith('-'));
    if (!target) return fail('umount', "missing operand (try 'umount --help')");

    const path = ctx.fs.resolvePath(ctx.cwd, target);
    if (PINNED_MOUNTS.has(path)) return fail('umount', `${path}: cannot unmount`);

    const backend = await backendAt(path);
    if (!backend) return fail('umount', `${path}: not mounted`);
    if (backend !== 'memory' && !force) {
      return fail('umount', `${path}: holds persistent data on ${backend}; use -f to detach anyway`);
    }
    try {
      await unmountBackend(path);
    } catch (e) {
      return fail('umount', (e as Error).message);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

const fail = (command: string, message: string): ExecResult => ({
  stdout: '',
  stderr: `${command}: ${message}\n`,
  exitCode: 1,
});

/** Accepted and ignored, exactly as real df ignores them. */
const DF_NOOP_FLAGS = new Set(['-v', '-P', '-l', '-a', '--all', '--sync', '--no-sync', '--local']);

const makeDfCommand = (getZfs: () => ZenFsLike) =>
  defineCommand('df', async (args, ctx) => {
    const help = helpFor('df', args, false); // -h is human-readable, as in real df
    if (help) return help;
    let human = false;
    let scan = false;
    let showType = false;
    const paths: string[] = [];
    for (const arg of expandFlags(args)) {
      if (DF_NOOP_FLAGS.has(arg)) continue;
      else if (arg === '-h') human = true;
      else if (arg === '-k') human = false;
      else if (arg === '-T') showType = true;
      else if (arg === '--scan') scan = true;
      else if (arg.startsWith('-'))
        return {
          stdout: '',
          stderr: `df: unrecognized option '${arg}'\nTry 'df --help' for more information.\n`,
          exitCode: 2,
        };
      else paths.push(arg);
    }

    const report = await probeStorage({ scan, zfs: getZfs() });
    let devices = report.devices;
    if (paths.length) {
      const wanted = new Set(
        paths.map((p) => mountOf(ctx.fs.resolvePath(ctx.cwd, p), devices)).filter(Boolean),
      );
      devices = devices.filter((d) => d.mountPoint && wanted.has(d.mountPoint));
      if (!devices.length) return { stdout: '', stderr: 'df: no matching file system\n', exitCode: 1 };
    }

    const withType = (row: string[], type: string) =>
      showType ? [row[0], type, ...row.slice(1)] : row;

    const rows = devices.map((d) =>
      withType(
        [d.source, '-', fmtSize(d.used, human), '-', '-', d.mountPoint ?? `(${d.options[0]})`],
        d.type,
      ),
    );
    if (!paths.length && report.origin) {
      const { host, usage, quota } = report.origin;
      rows.push(
        withType(
          [
            `origin:${host}`,
            fmtSize(quota, human),
            fmtSize(usage, human),
            fmtSize(Math.max(0, quota - usage), human),
            pct(usage, quota),
            '-',
          ],
          'quota',
        ),
      );
    }

    const header = withType(
      ['Filesystem', human ? 'Size' : '1K-blocks', 'Used', 'Avail', 'Use%', 'Mounted on'],
      'Type',
    );
    return {
      stdout: renderTable(header, rows, showType ? [2, 3, 4, 5] : [1, 2, 3, 4]),
      stderr: '',
      exitCode: 0,
    };
  });

const makeFindmntCommand = () =>
  defineCommand('findmnt', async (args) => {
    const help = helpFor('findmnt', args);
    if (help) return help;
    const { devices } = await probeStorage({});
    const rows = mounted(devices).map((d) => [
      d.mountPoint as string,
      d.source,
      d.type,
      d.options.join(','),
    ]);
    return {
      stdout: renderTable(['TARGET', 'SOURCE', 'FSTYPE', 'OPTIONS'], rows),
      stderr: '',
      exitCode: 0,
    };
  });

const makeLsblkCommand = () =>
  defineCommand('lsblk', async (args) => {
    const help = helpFor('lsblk', args);
    if (help) return help;
    let fsMode = false;
    for (const arg of expandFlags(args)) {
      if (arg === '-f' || arg === '--fs') fsMode = true;
      else return { stdout: '', stderr: USAGE.lsblk, exitCode: 2 };
    }

    const { devices, origin } = await probeStorage({});
    const quota = origin?.quota;
    const branch = (i: number) => (i === devices.length - 1 ? '└─' : '├─');

    const header = fsMode
      ? ['NAME', 'FSTYPE', 'LABEL', 'UUID', 'FSUSE%', 'MOUNTPOINTS']
      : ['NAME', 'SIZE', 'TYPE', 'MOUNTPOINTS'];
    const rows = [
      fsMode
        ? ['origin', 'quota', origin?.host ?? '-', '-', pct(origin?.usage ?? null, quota), '']
        : ['origin', fmtSize(quota ?? null, true), 'disk', ''],
      ...devices.map((d, i) =>
        fsMode
          ? [
              `${branch(i)}${d.name}`,
              d.type,
              d.label,
              d.uuid ?? '-',
              pct(d.used, quota),
              d.mountPoint ?? '',
            ]
          : [`${branch(i)}${d.name}`, '-', 'part', d.mountPoint ?? ''],
      ),
    ];
    return { stdout: renderTable(header, rows), stderr: '', exitCode: 0 };
  });

const makeFdiskCommand = () =>
  defineCommand('fdisk', async (args) => {
    const help = helpFor('fdisk', args);
    if (help) return help;
    if (!args.includes('-l') && !args.includes('--list')) {
      return {
        stdout: '',
        stderr: "fdisk: read-only view; try 'fdisk -l' or 'fdisk --help'\n",
        exitCode: 1,
      };
    }
    const { devices, origin } = await probeStorage({});
    const size = origin ? `${fmtSize(origin.quota, true)}iB, ${origin.quota} bytes` : 'size unavailable';
    const head = [
      `Disk /dev/origin: ${size}`,
      `Disk model: browser storage quota (${origin?.host ?? 'no browser'})`,
      'Units: bytes — a quota is not a block device, so there are no sectors',
      'Disklabel type: browser-storage (one quota shared by every partition)',
      '',
      '',
    ].join('\n');
    const rows = devices.map((d) => [
      `/dev/${d.name}`,
      d.type,
      fmtSize(d.used, true),
      d.mountPoint ?? '-',
    ]);
    return {
      stdout: head + renderTable(['Device', 'Type', 'Used', 'Mountpoint'], rows, [2]),
      stderr: '',
      exitCode: 0,
    };
  });

const makeDiskutilCommand = () =>
  defineCommand('diskutil', async (args) => {
    const help = helpFor('diskutil', args);
    if (help) return help;
    if (args[0] === 'help') return { stdout: USAGE.diskutil, stderr: '', exitCode: 0 };
    if (args[0] !== 'list') {
      return {
        stdout: '',
        stderr: "diskutil: read-only view; only 'diskutil list' is supported\n",
        exitCode: 1,
      };
    }
    const { devices, origin } = await probeStorage({});
    const rows = [
      [
        '0:',
        'browser_quota',
        origin?.host ?? 'no browser',
        fmtSize(origin?.quota ?? null, true),
        'origin',
      ],
      ...devices.map((d, i) => [`${i + 1}:`, d.type, d.label, fmtSize(d.used, true), d.name]),
    ];
    const table = renderTable(['#:', 'TYPE', 'NAME', 'SIZE', 'IDENTIFIER'], rows, [0, 1, 3])
      .replace(/^/gm, '   ')
      .replace(/ +$/gm, '');
    return {
      stdout: `/dev/origin (browser, shared quota):\n${table}`,
      stderr: '',
      exitCode: 0,
    };
  });

export const makeStorageCommands = (getZfs: () => ZenFsLike) => [
  makeMountCommand(),
  makeUmountCommand(),
  makeDfCommand(getZfs),
  makeFindmntCommand(),
  makeLsblkCommand(),
  makeFdiskCommand(),
  makeDiskutilCommand(),
];

/** Expands clustered short flags so `df -vh` behaves like `df -v -h`. */
function expandFlags(args: string[]): string[] {
  const out: string[] = [];
  for (const arg of args) {
    if (/^-[^-]{2,}$/.test(arg)) out.push(...arg.slice(1).split('').map((c) => `-${c}`));
    else out.push(arg);
  }
  return out;
}

/** Longest mount point that is a prefix of `path`. */
function mountOf(path: string, devices: StorageDevice[]): string {
  let best = '';
  for (const d of devices) {
    const m = d.mountPoint;
    if (!m) continue;
    if ((path === m || path.startsWith(m === '/' ? '/' : `${m}/`)) && m.length >= best.length) best = m;
  }
  return best;
}

function pct(used: number | null, quota: number | undefined): string {
  if (used === null || !quota) return '-';
  return `${Math.round((used / quota) * 100)}%`;
}

const UNITS = ['K', 'M', 'G', 'T', 'P'];

function fmtSize(bytes: number | null, human: boolean): string {
  if (bytes === null) return '-';
  if (!human) return String(Math.ceil(bytes / 1024));
  if (bytes === 0) return '0';
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && value % 1 !== 0 ? value.toFixed(1) : Math.round(value)}${UNITS[unit]}`;
}
