#!/usr/bin/env node
/**
 * The artipod CLI: `artipod run -it [REF]` boots a pod and drops you into an
 * artipod-bash — the same sandbox the browser and agents use, with the
 * `artipod` verbs (snapshot/commit/push/pull/clone/…) wired to a local
 * OCI-layout store and, for image refs, the public registries.
 *
 * Pods are kept on disk by default (~/.artipod/pods/<pod-id>) so past runs
 * survive exit — `artipod pods` lists them (the `docker ps -a` of pods) and
 * `artipod run -it <pod-id>` resumes one. `--rm` opts into a throwaway in-RAM
 * pod (`--rm --disk` for a deleted-on-exit temp dir instead); `--dir` keeps
 * the pod at a chosen path. REF materializes the ref's merged view into the
 * writable root (clone semantics — layered base+upper `run` arrives with
 * manifest root.image realization).
 */
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { stdin, stdout, exit, argv, env } from 'node:process';
import { createZenFsPod, type ZenFsPod } from './realize/zenfs.js';
import type { PodManifest } from './manifest.js';
import { OciLayoutPodStore } from './manager/pod-store.js';
import { newSuperblock, OCI_ROOT, SUPERBLOCK_PATH, type PodSuperblock } from './oci/store.js';
import { storeTransport, materializeImage } from './manager/sync.js';
import { DirectRegistryTransport, parseImageRef, formatImageRef } from './oci/transport.js';
import { pullImage } from './oci/pull.js';
import { publishDirectory } from './server/folder.js';
import type { ServeCliOptions } from './server/serve.js';
import { nodePodFs } from './nodePodFs.js';

const HELP = `usage:
  artipod run [-it] [REF|POD] [flags]   boot a pod: empty, resumed from a kept POD id,
                                        or materialized from an image/volume REF
  artipod import <dir> <name:tag>       snapshot a host folder into the store as an
                                        image ref (no pod) — content-addressed, so
                                        re-importing an unchanged tree is a no-op
  artipod pods [--pods <path>]          list kept pods, newest first (docker ps -a for pods)
  artipod rm [--pods <path>] POD...     delete kept pods by id (unique prefix ok)
  artipod prune [-f] [-a] [--pods <path>]  delete untagged kept pods (-a: ALL); asks first
                                        unless -f — a pod is tagged once you \`artipod
                                        commit --tag <name>:<tag>\` inside the shell
  artipod serve [flags]                 host the store over HTTP: the native sync
                                        surface (/api/pods), OCI relay, git proxy,
                                        and exec sessions — one URL, embeddable via
                                        @artipod/core/server createArtipodApp
  artipod --help | --version

flags for run:
  -i, -t, -it        interactive shell (default when stdin is a TTY and no -c)
  -c <command>       run one shell line and exit with its code
  --rm               ephemeral pod: keep nothing after exit (lives in RAM)
  --disk             with --rm: back the pod by a deleted-on-exit temp dir instead of
                     RAM (for working sets bigger than memory)
  --dir <path>       keep the pod at <path> instead of under the pods root
  --pods <path>      pods root for kept pods and POD-id lookup
                     (default: ~/.artipod/pods, env ARTIPOD_PODS)
  --store <path>     local OCI-layout store used by push/pull/clone and REF lookup
                     (default: ~/.artipod/store, env ARTIPOD_STORE)
  --registry         resolve REF via the public registry even if the store has it
  --at <path>        where REF materializes (default: '/' for artipod volume refs,
                     '/rootfs' for container images — their ELF binaries can't run in
                     artipod-bash, so the shell's builtins stay resolvable)
  --base <dir>[:<podpath>]   import <dir> into the store and materialize it at
                     <podpath> (default '/'); repeat to stack folders in order (later
                     --base wins on conflicts, and both stack on top of REF when one
                     is given) — commit inside the shell to freeze the merged result
                     as a layer. NOTE: /mnt, /dev, /proc are excluded from commits;
                     use e.g. :/work for content you mean to commit
  -v <dir>:<podpath>[:ro|:cow]   mount a host folder LIVE at <podpath> (docker -v);
                     repeatable. Default rw — writes inside the shell land in the
                     real folder. :cow keeps writes in RAM (host never touched);
                     :ro marks it read-only for tools and keeps it out of commits
                     (shell-level enforcement arrives with view mounts). rw/cow
                     mounts are commit roots — mount under /mnt to keep them out

examples:
  artipod run -it                      # fresh pod, kept under ~/.artipod/pods (untouched pods
                                       # are removed again — create-on-write)
  artipod run -it 500edf8b             # resume a kept pod by id prefix (see: artipod pods)
  artipod run -it alpine:3.22          # registry image, cloned into the pod root
  artipod run -it field/notes:1        # a ref you pushed earlier (from --store)
  artipod run --rm -it                 # throwaway: RAM only, gone on exit
  artipod import ~/proj team/proj:1    # folder → image in the store; run it later by ref
  artipod run -it --base ~/skel --base ./patches   # stack folders (later wins)
  artipod run -it --base ~/proj:/work  # materialize the folder under /work instead of /
  artipod run -it -v ~/data:/mnt/data:ro   # live host mount to copy from (cp into /work)

flags for serve:
  --port <n>         listen port (default 2784; 0 = OS-assigned)
  --host <addr>      bind address (default 127.0.0.1); a non-localhost bind with
                     no token generates one and requires it on every surface
  --store <path>     the served OCI-layout store (default ~/.artipod/store,
                     env ARTIPOD_STORE)
  --publish <dir>    snapshot a folder into the store at boot (<basename>:latest)
                     and write pushed heads back into it (repeatable)
  --token <t>        require 'Authorization: Bearer <t>' (or Basic — docker login)
                     on every surface, read-write (env ARTIPOD_SERVE_TOKEN)
  --read-token <t>   read-only token: pulls yes, pushes/exec no
                     (env ARTIPOD_SERVE_READ_TOKEN)
  --lock <ref>       lock a tag (immutable: every head move is refused with 403;
                     repeatable, persisted in <store>/locks.json)
  --unlock <ref>     release a locked tag (repeatable)
  --seal-pattern <re>  which tags are create-once. DEFAULT: '^[^_]' — every tag
                     not starting with _ seals on its first push; _-tags stay
                     mutable (open drafts/workstreams). A sealed tag refuses
                     moves and deletes with 403 (env ARTIPOD_SEAL_PATTERN)
  --no-seal          disable seal enforcement (classic mutable-tag registry)
  --only web|registry   narrow the surfaces (default: both)
  --cors <origin>    allow a browser origin (repeatable; default deny)
  --oci-allow <host> allow an upstream registry host for the relay (repeatable;
                     env ARTIPOD_OCI_ALLOWED_HOSTS; default deny)
  --no-exec          disable the exec-session surface
  --no-ui            headless landing only (skip UI resolution); the UI resolves
                     local-first: ARTIPOD_UI_DIR (a static build), then the
                     ARTIPOD_UI_REF ref in the store (default artipod-ui:latest)
  --open             open the printed URL in a browser

inside the shell, run \`artipod\` for the pod verbs (snapshot, commit, push, …).
`;

interface RunArgs {
  ref?: string;
  interactive: boolean;
  command?: string;
  dir?: string;
  store: string;
  podsRoot: string;
  rm: boolean;
  disk: boolean;
  forceRegistry: boolean;
  at?: string;
  /** Host folders stacked onto '/' in order (later wins) — see --base. */
  bases: string[];
  /** Live hostDir mounts, docker-style '<dir>:<podpath>[:ro|:cow]' — see -v. */
  volumes: string[];
}

function parseArgs(
  args: string[],
):
  | RunArgs
  | { help: true }
  | { version: true }
  | { pods: true; podsRoot: string }
  | { removeIds: string[]; podsRoot: string }
  | { prune: true; force: boolean; all: boolean; podsRoot: string }
  | { importDir: string; importRef: string; store: string }
  | { serve: ServeCliOptions } {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) return { help: true };
  if (args.includes('--version')) return { version: true };
  const [verb, ...rest] = args;
  const defaultPodsRoot = env.ARTIPOD_PODS ?? resolve(homedir(), '.artipod/pods');
  if (verb === 'pods') {
    let podsRoot = defaultPodsRoot;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--pods') podsRoot = rest[++i];
      else {
        stdout.write(`artipod pods: unknown argument '${rest[i]}'\n\n${HELP}`);
        exit(2);
      }
    }
    return { pods: true, podsRoot };
  }
  if (verb === 'rm') {
    let podsRoot = defaultPodsRoot;
    const removeIds: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--pods') podsRoot = rest[++i];
      else if (rest[i].startsWith('-')) {
        stdout.write(`artipod rm: unknown flag '${rest[i]}'\n\n${HELP}`);
        exit(2);
      } else removeIds.push(rest[i]);
    }
    if (removeIds.length === 0) {
      stdout.write('artipod rm: which pod? (see `artipod pods`)\n');
      exit(2);
    }
    return { removeIds, podsRoot };
  }
  if (verb === 'import') {
    let store = env.ARTIPOD_STORE ?? resolve(homedir(), '.artipod/store');
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--store') store = rest[++i];
      else if (rest[i].startsWith('-')) {
        stdout.write(`artipod import: unknown flag '${rest[i]}'\n\n${HELP}`);
        exit(2);
      } else positional.push(rest[i]);
    }
    if (positional.length !== 2) {
      stdout.write('artipod import: expected a folder and a ref — artipod import <dir> <name:tag>\n');
      exit(2);
    }
    return { importDir: positional[0], importRef: positional[1], store };
  }
  if (verb === 'prune') {
    let podsRoot = defaultPodsRoot;
    let force = false;
    let all = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--pods') podsRoot = rest[++i];
      else if (rest[i] === '-f' || rest[i] === '--force') force = true;
      else if (rest[i] === '-a' || rest[i] === '--all') all = true;
      else {
        stdout.write(`artipod prune: unknown argument '${rest[i]}'\n\n${HELP}`);
        exit(2);
      }
    }
    return { prune: true, force, all, podsRoot };
  }
  if (verb === 'serve') {
    const serve: ServeCliOptions = {
      port: 2784,
      host: '127.0.0.1',
      store: env.ARTIPOD_STORE ?? resolve(homedir(), '.artipod/store'),
      cors: [],
      ociAllow: [],
      exec: true,
      publish: [],
      lock: [],
      unlock: [],
      open: false,
      ui: true,
    };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--port') {
        serve.port = Number(rest[++i]);
        if (!Number.isInteger(serve.port) || serve.port < 0 || serve.port > 65535) {
          stdout.write(`artipod serve: invalid --port '${rest[i]}'\n`);
          exit(2);
        }
      } else if (a === '--host') serve.host = rest[++i];
      else if (a === '--store') serve.store = rest[++i];
      else if (a === '--only') {
        const only = rest[++i];
        if (only !== 'web' && only !== 'registry') {
          stdout.write(`artipod serve: --only takes 'web' or 'registry', not '${only}'\n`);
          exit(2);
        }
        serve.only = only;
      } else if (a === '--cors') serve.cors.push(rest[++i]);
      else if (a === '--oci-allow') serve.ociAllow.push(rest[++i]);
      else if (a === '--publish') serve.publish.push(rest[++i]);
      else if (a === '--token') serve.token = rest[++i];
      else if (a === '--read-token') serve.readToken = rest[++i];
      else if (a === '--lock') serve.lock.push(rest[++i]);
      else if (a === '--unlock') serve.unlock.push(rest[++i]);
      else if (a === '--seal-pattern') {
        serve.sealPattern = rest[++i];
        try {
          new RegExp(serve.sealPattern);
        } catch {
          stdout.write(`artipod serve: invalid --seal-pattern '${serve.sealPattern}'\n`);
          exit(2);
        }
      } else if (a === '--no-seal') serve.noSeal = true;
      else if (a === '--no-exec') serve.exec = false;
      else if (a === '--no-ui') serve.ui = false;
      else if (a === '--open') serve.open = true;
      else {
        stdout.write(`artipod serve: unknown argument '${a}'\n\n${HELP}`);
        exit(2);
      }
    }
    return { serve };
  }
  if (verb !== 'run') {
    stdout.write(
      `artipod: unknown command '${verb}' — top-level commands are run, import, serve, pods, rm, and prune; the pod verbs live INSIDE the shell (try: artipod run -it)\n\n${HELP}`,
    );
    exit(2);
  }
  const out: RunArgs = {
    interactive: false,
    store: env.ARTIPOD_STORE ?? resolve(homedir(), '.artipod/store'),
    podsRoot: defaultPodsRoot,
    rm: false,
    disk: false,
    forceRegistry: false,
    bases: [],
    volumes: [],
  };
  let sawInteractiveFlag = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-i' || a === '-t' || a === '-it' || a === '-ti') sawInteractiveFlag = true;
    else if (a === '-c') out.command = rest[++i];
    else if (a === '--rm') out.rm = true;
    else if (a === '--disk') out.disk = true;
    else if (a === '--dir') out.dir = rest[++i];
    else if (a === '--pods') out.podsRoot = rest[++i];
    else if (a === '--store') out.store = rest[++i];
    else if (a === '--at') out.at = rest[++i];
    else if (a === '--base') out.bases.push(rest[++i]);
    else if (a === '-v' || a === '--volume') out.volumes.push(rest[++i]);
    else if (a === '--registry') out.forceRegistry = true;
    else if (a.startsWith('-')) {
      stdout.write(`artipod run: unknown flag '${a}'\n\n${HELP}`);
      exit(2);
    } else if (!out.ref) out.ref = a;
    else {
      stdout.write(`artipod run: unexpected argument '${a}'\n\n${HELP}`);
      exit(2);
    }
  }
  if (out.disk && !out.rm) {
    stdout.write(`artipod run: --disk only modifies --rm (kept pods are disk-backed already)\n`);
    exit(2);
  }
  out.interactive = sawInteractiveFlag || (!out.command && stdin.isTTY === true);
  return out;
}

/** Where the pod root lives for this run — and what that implies at exit. */
interface PodLocation {
  /** Host directory backing '/' — undefined means RAM (ZenFS memory backend). */
  dir?: string;
  /** rm -rf the dir after the run (`--rm --disk` temp dirs). */
  cleanup: boolean;
  /** REF turned out to be a kept pod id — reopen it, don't materialize. */
  resumed: boolean;
  /** The pod survives exit (pods-root or --dir). */
  kept: boolean;
}

const tildify = (p: string): string => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

/** docker-style lookup: exact dir name under the pods root, then unique prefix. */
async function findPod(root: string, idOrPrefix: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (names.includes(idOrPrefix)) return join(root, idOrPrefix);
  const hits = names.filter((n) => n.startsWith(idOrPrefix));
  if (hits.length > 1) throw new Error(`pod id '${idOrPrefix}' is ambiguous: ${hits.join(', ')}`);
  return hits.length === 1 ? join(root, hits[0]) : null;
}

async function resolvePodLocation(args: RunArgs): Promise<PodLocation> {
  if (args.rm) {
    if (!args.disk) return { cleanup: false, resumed: false, kept: false };
    const dir = await mkdtemp(join(tmpdir(), 'artipod-rm-'));
    return { dir, cleanup: true, resumed: false, kept: false };
  }
  if (args.dir) return { dir: resolve(args.dir), cleanup: false, resumed: false, kept: true };
  const root = resolve(args.podsRoot);
  if (args.ref) {
    const hit = await findPod(root, args.ref);
    if (hit) return { dir: hit, cleanup: false, resumed: true, kept: true };
  }
  // Fresh kept pod: pre-seed the superblock so the dir name IS the pod id.
  const sb = newSuperblock();
  const dir = join(root, sb.podId);
  await mkdir(dirname(join(dir, SUPERBLOCK_PATH)), { recursive: true });
  await writeFile(join(dir, SUPERBLOCK_PATH), JSON.stringify(sb, null, 2));
  return { dir, cleanup: false, resumed: false, kept: true };
}

async function bootPod(args: RunArgs, dir?: string): Promise<ZenFsPod> {
  if (dir) await mkdir(dir, { recursive: true });
  const manifest: PodManifest = {
    formatVersion: 1,
    mounts: [
      dir
        ? { name: 'work', path: '/', mode: 'rw', source: { kind: 'hostDir', dir } }
        : { name: 'work', path: '/', mode: 'rw', source: { kind: 'backend', backend: 'memory' } },
      ...args.volumes.map((spec, i) => {
        const v = parseVolumeSpec(spec);
        return { name: `vol${i}`, path: v.at, mode: v.mode, source: { kind: 'hostDir' as const, dir: resolve(v.dir) } };
      }),
    ],
  };
  await mkdir(resolve(args.store), { recursive: true });
  const store = new OciLayoutPodStore(nodePodFs(), resolve(args.store));
  await store.init();
  return createZenFsPod(manifest, {
    proc: true,
    cwd: '/',
    sync: { remote: store },
    oci: { transport: new DirectRegistryTransport() },
    hydration: {},
  });
}

/** Stamp updatedAt so LAST USED in `artipod pods` reflects boots, not just store writes. */
async function touchSuperblock(pod: ZenFsPod): Promise<void> {
  const sb = { ...pod.oci.store.getSuperblock(), updatedAt: new Date().toISOString() };
  await pod.zfs.promises.writeFile(SUPERBLOCK_PATH, JSON.stringify(sb, null, 2));
}

async function duBytes(path: string): Promise<number> {
  const st = await lstat(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await readdir(path)) total += await duBytes(join(path, name));
  return total;
}

/** Fingerprint a tree: dirs contribute existence, files size+mtime. The
 * top-level 'proc' dir is runtime scaffolding (virtual /proc materializes an
 * empty real dir on Passthrough) — never user data, so it is ignored. */
async function dirState(dir: string, rel = '', out = new Map<string, string>()): Promise<Map<string, string>> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (rel === '' && e.name === 'proc') continue;
    const path = join(dir, e.name);
    const key = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      out.set(key, 'dir');
      await dirState(path, key, out);
    } else {
      const st = await lstat(path);
      out.set(key, `${st.size}:${st.mtimeMs}`);
    }
  }
  return out;
}

function sameState(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  for (const unit of ['kB', 'MB', 'GB', 'TB']) {
    n /= 1024;
    if (n < 1024) return `${n >= 10 ? Math.round(n) : Math.round(n * 10) / 10}${unit}`;
  }
  return `${Math.round(n)}PB`;
}

function ago(iso: string): string {
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  const step = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (s < 60) return 'just now';
  if (s < 3600) return step(Math.floor(s / 60), 'minute');
  if (s < 86400) return step(Math.floor(s / 3600), 'hour');
  if (s < 86400 * 30) return step(Math.floor(s / 86400), 'day');
  return iso.slice(0, 10);
}

async function listPods(root: string): Promise<void> {
  const empty = () =>
    stdout.write(`no pods yet — \`artipod run -it\` keeps one under ${tildify(root)} (\`--rm\` for throwaways)\n`);
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    empty();
    return;
  }
  const rows: { id: string; tags: string; created: string; used: string; size: number }[] = [];
  for (const name of names) {
    try {
      const sb = JSON.parse(await readFile(join(root, name, SUPERBLOCK_PATH), 'utf8')) as PodSuperblock;
      rows.push({
        id: name,
        tags: (await podTags(join(root, name))).join(',') || '-',
        created: sb.createdAt,
        used: sb.updatedAt,
        size: await duBytes(join(root, name)),
      });
    } catch {
      // not a pod dir (no readable superblock) — leave it alone
    }
  }
  if (rows.length === 0) {
    empty();
    return;
  }
  rows.sort((a, b) => (a.used < b.used ? 1 : -1));
  const table: string[][] = [
    ['POD ID', 'TAGS', 'CREATED', 'LAST USED', 'SIZE'],
    ...rows.map((r) => [r.id, r.tags, ago(r.created), ago(r.used), fmtSize(r.size)]),
  ];
  const widths = table[0].map((_, c) => Math.max(...table.map((row) => row[c].length)));
  for (const row of table) {
    stdout.write(`${row.map((cell, c) => cell.padEnd(widths[c] + 2)).join('').trimEnd()}\n`);
  }
  stdout.write(
    `\n${rows.length} pod${rows.length === 1 ? '' : 's'} under ${tildify(root)} — resume: artipod run -it <POD ID> · delete: artipod rm <POD ID> · prune untagged: artipod prune (-a: all)\n`,
  );
}

/** Only dirs carrying a pod superblock are ever deleted by rm/prune. */
async function isPodDir(dir: string): Promise<boolean> {
  try {
    await lstat(join(dir, SUPERBLOCK_PATH));
    return true;
  } catch {
    return false;
  }
}

/** Tags committed inside the pod — decoded filenames of its private ref store. */
async function podTags(dir: string): Promise<string[]> {
  try {
    const names = await readdir(join(dir, OCI_ROOT, 'refs'));
    return names.filter((n) => n.endsWith('.json')).map((n) => decodeURIComponent(n.slice(0, -5)));
  } catch {
    return [];
  }
}

async function removePods(root: string, ids: string[]): Promise<void> {
  for (const id of ids) {
    const dir = await findPod(root, id);
    if (!dir) throw new Error(`no such pod: ${id} (see \`artipod pods\`)`);
    if (!(await isPodDir(dir))) throw new Error(`${tildify(dir)} has no pod superblock — not deleting it`);
    const size = await duBytes(dir);
    await rm(dir, { recursive: true, force: true });
    stdout.write(`removed ${basename(dir)} (${fmtSize(size)})\n`);
  }
}

async function prunePods(root: string, force: boolean, all: boolean): Promise<void> {
  let names: string[] = [];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // no pods root yet
  }
  const pods: string[] = [];
  let spared = 0;
  for (const name of names) {
    if (!(await isPodDir(join(root, name)))) continue;
    if (!all && (await podTags(join(root, name))).length > 0) {
      spared++;
      continue;
    }
    pods.push(name);
  }
  const sparedNote = spared > 0 ? ` · spared ${spared} tagged pod${spared === 1 ? '' : 's'} (-a removes them too)` : '';
  if (pods.length === 0) {
    stdout.write(`nothing to prune${sparedNote}\n`);
    return;
  }
  if (!force) {
    if (stdin.isTTY !== true) {
      throw new Error('prune: refusing to delete pods without -f (stdin is not a TTY)');
    }
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: stdin, output: stdout });
    const what = all
      ? `ALL ${pods.length} kept pod${pods.length === 1 ? '' : 's'}`
      : `${pods.length} untagged pod${pods.length === 1 ? '' : 's'}`;
    const answer = await rl.question(`WARNING! This deletes ${what} under ${tildify(root)}.\nAre you sure? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      stdout.write('aborted\n');
      return;
    }
  }
  let reclaimed = 0;
  for (const name of pods) {
    const dir = join(root, name);
    reclaimed += await duBytes(dir);
    await rm(dir, { recursive: true, force: true });
    stdout.write(`removed ${name}\n`);
  }
  stdout.write(`total reclaimed: ${fmtSize(reclaimed)}${sparedNote}\n`);
}

/** Materialize REF into the pod: store-first, registry fallback. Volume refs
 * land at '/'; container images at '/rootfs' (their binaries are ELF — they'd
 * shadow artipod-bash's builtins via PATH without ever being runnable). */
async function materializeRef(pod: ZenFsPod, args: RunArgs): Promise<void> {
  const ref = args.ref!;
  const store = await openLayoutStore(args.store);
  const canonical = (() => {
    try {
      return formatImageRef(parseImageRef(ref));
    } catch {
      return ref;
    }
  })();
  const stored = args.forceRegistry ? null : ((await store.getRef(ref)) ?? (await store.getRef(canonical)));
  const transport = stored ? storeTransport(store) : new DirectRegistryTransport();
  const from = stored ? `store ${args.store}` : 'registry';
  stdout.write(`pulling ${ref} (${from}) …\n`);
  const pulled = await pullImage({
    store: pod.oci.store,
    transport,
    ref,
    onProgress: (m) => stdout.write(`  ${m}\n`),
  });
  await pod.oci.store.putRef(ref, pulled.manifestDigest, 'application/vnd.oci.image.manifest.v1+json');
  const manifest = JSON.parse(new TextDecoder().decode(await pod.oci.store.getBlob(pulled.manifestDigest))) as {
    config?: { mediaType?: string; digest?: string };
  };
  // Volume-flavored commits and `artipod import`ed folders belong at '/';
  // only container-image rootfs trees get shunted to /rootfs.
  let isVolume = manifest.config?.mediaType === 'application/vnd.artipod.volume.v1+json';
  if (!isVolume && manifest.config?.digest) {
    try {
      const config = JSON.parse(new TextDecoder().decode(await pod.oci.store.getBlob(manifest.config.digest as never))) as {
        artipod?: unknown;
      };
      isVolume = config.artipod !== undefined;
    } catch {
      // unreadable config — keep the container-image default
    }
  }
  const at = args.at ?? (isVolume ? '/' : '/rootfs');
  const result = await materializeImage({ store: pod.oci.store, zfs: pod.zfs, refOrDigest: pulled.manifestDigest, at });
  stdout.write(`materialized ${ref} at ${at}: ${result.files} files (writable)${at !== '/' ? ` — cd ${at}` : ''}\n`);
}

async function openLayoutStore(path: string): Promise<OciLayoutPodStore> {
  await mkdir(resolve(path), { recursive: true });
  const store = new OciLayoutPodStore(nodePodFs(), resolve(path));
  await store.init();
  return store;
}

async function assertDirectory(verb: string, dir: string): Promise<string> {
  const abs = resolve(dir);
  const st = await lstat(abs).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`artipod ${verb}: '${dir}' is not a directory`);
  return abs;
}

/** `--base <dir>[:<podpath>]` — the target is the suffix after the last ':'
 * that starts a '/', so host paths containing ':' stay parseable. */
function parseBaseSpec(spec: string): { dir: string; at: string } {
  const i = spec.lastIndexOf(':/');
  if (i > 0) return { dir: spec.slice(0, i), at: spec.slice(i + 1).replace(/\/+$/, '') || '/' };
  return { dir: spec, at: '/' };
}

/** `-v <dir>:<podpath>[:ro|:cow|:rw]` — docker volume syntax; the pod path is
 * required and must not shadow the root mount. */
function parseVolumeSpec(spec: string): { dir: string; at: string; mode: 'rw' | 'ro' | 'cow' } {
  let rest = spec;
  let mode: 'rw' | 'ro' | 'cow' = 'rw';
  const m = /:(ro|rw|cow)$/.exec(rest);
  if (m) {
    mode = m[1] as typeof mode;
    rest = rest.slice(0, -m[0].length);
  }
  const i = rest.lastIndexOf(':/');
  if (i <= 0) throw new Error(`artipod run -v: expected <hostdir>:</pod/path>[:ro|:cow] (got '${spec}')`);
  const at = rest.slice(i + 1).replace(/\/+$/, '');
  if (!at || at === '/') throw new Error(`artipod run -v: mount target must be a pod path other than '/' (got '${spec}')`);
  return { dir: rest.slice(0, i), at, mode };
}

/** `artipod import <dir> <name:tag>` — folder → image ref in the store. */
async function importDirectory(dir: string, ref: string, storePath: string): Promise<void> {
  const abs = await assertDirectory('import', dir);
  const store = await openLayoutStore(storePath);
  const result = await publishDirectory(store, abs, ref);
  for (const w of result.warnings.slice(0, 10)) stdout.write(`warning: ${w}\n`);
  if (result.warnings.length > 10) stdout.write(`… and ${result.warnings.length - 10} more warnings\n`);
  if (result.unchanged) {
    stdout.write(`${ref} already matches ${tildify(abs)} — store untouched\n`);
    return;
  }
  stdout.write(
    `imported ${tildify(abs)} → ${ref}: ${result.layers} layer${result.layers === 1 ? '' : 's'} ` +
      `(${result.reusedLayers} reused), ${fmtSize(result.bytes)} new — run it: artipod run -it ${ref}\n`,
  );
}

/** Stack the --base folders in order: each is imported into the store
 * (content-addressed — unchanged trees dedup to a no-op) and then
 * materialized at its target path (default '/'), so later bases win and the
 * merged result is commit-able. */
async function materializeBases(pod: ZenFsPod, args: RunArgs): Promise<void> {
  const store = await openLayoutStore(args.store);
  for (const base of args.bases) {
    const { dir, at } = parseBaseSpec(base);
    const abs = await assertDirectory('run --base', dir);
    const name = basename(abs).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '') || 'dir';
    const ref = `base/${name}:latest`;
    const pub = await publishDirectory(store, abs, ref);
    const pulled = await pullImage({ store: pod.oci.store, transport: storeTransport(store), ref });
    await pod.oci.store.putRef(ref, pulled.manifestDigest, 'application/vnd.oci.image.manifest.v1+json');
    const result = await materializeImage({ store: pod.oci.store, zfs: pod.zfs, refOrDigest: pulled.manifestDigest, at });
    stdout.write(`base ${tildify(abs)} → ${ref} (${pub.manifestDigest.slice(7, 19)}): ${result.files} files at ${at}\n`);
  }
}

async function repl(pod: ZenFsPod, note?: string): Promise<number> {
  const sandbox = pod.createSandbox();
  const { createInterface } = await import('node:readline');
  let abort: AbortController | null = null;
  let sigintArmed = false;

  const rl = createInterface({
    input: stdin,
    output: stdout,
    terminal: stdin.isTTY === true,
    completer: (line: string, callback: (err: Error | null, result: [string[], string]) => void) => {
      sandbox
        .complete(line)
        .then(({ candidates, replaceStart }) => callback(null, [candidates, line.slice(replaceStart)]))
        .catch(() => callback(null, [[], line]));
    },
  });

  const prompt = () => {
    rl.setPrompt(`${sandbox.getCwd()} $ `);
    rl.prompt();
  };

  const banner = [
    `artipod ${pod.oci.store.getSuperblock().podId} — type \`artipod\` for pod verbs, \`exit\` to leave`,
    `mounts: ${pod.mountTable.map((m) => `${m.path}${m.readonly ? ':ro' : ''}`).join(', ')}`,
    ...(note ? [note] : []),
    '',
  ].join('\n');
  stdout.write(banner);

  return new Promise<number>((resolveExit) => {
    let lastCode = 0;
    let running = false;
    let closed = false;
    const queue: string[] = [];

    const finish = () => {
      stdout.write('\n');
      pod.dispose();
      resolveExit(lastCode);
    };

    // Piped scripts hit EOF ('close') while lines are still queued or a
    // disk-backed command is mid-flight — keep draining, then finish.
    const continueOrFinish = () => {
      const next = queue.shift();
      if (next !== undefined) void handle(next);
      else if (closed) finish();
      else prompt();
    };

    const runLine = async (line: string) => {
      running = true;
      abort = new AbortController();
      try {
        const r = await sandbox.exec(line, { signal: abort.signal });
        if (r.stdout) stdout.write(r.stdout);
        if (r.stderr) stdout.write(r.stderr);
        lastCode = r.exitCode;
      } catch (e) {
        stdout.write(`${String(e)}\n`);
        lastCode = 1;
      } finally {
        abort = null;
        running = false;
      }
      continueOrFinish();
    };

    const handle = async (raw: string) => {
      const line = raw.trim();
      sigintArmed = false;
      if (line === 'exit' || line === 'logout') {
        if (closed) finish();
        else rl.close();
        return;
      }
      if (!line) {
        continueOrFinish();
        return;
      }
      await runLine(line);
    };

    rl.on('line', (line) => {
      if (running) queue.push(line);
      else void handle(line);
    });

    rl.on('SIGINT', () => {
      if (running && abort) {
        abort.abort();
        stdout.write('^C\n');
        return;
      }
      if (sigintArmed) {
        rl.close();
        return;
      }
      sigintArmed = true;
      stdout.write('^C (press Ctrl+C again or type `exit` to leave)\n');
      prompt();
    });

    rl.on('close', () => {
      if (closed) return;
      closed = true;
      if (!running && queue.length === 0) finish();
    });

    prompt();
  });
}

function bannerNote(args: RunArgs, loc: PodLocation): string {
  if (!loc.kept) return `ephemeral (--rm): nothing survives exit${loc.dir ? ' (temp-dir backed)' : ''}`;
  if (args.dir) return `kept at ${tildify(loc.dir!)}`;
  if (loc.resumed) return `kept at ${tildify(loc.dir!)} — resume: artipod run -it ${basename(loc.dir!).slice(0, 8)} · list: artipod pods`;
  return `kept at ${tildify(loc.dir!)} once you write (untouched pods are removed) — resume: artipod run -it ${basename(loc.dir!).slice(0, 8)}`;
}

/** "artipod <version> (<commit>, <commit date>)" — buildinfo.json is baked by
 * postbuild; the version auto-bumps from git tags (`0.3.1+5` = 5 commits past
 * tag 0.3.1). Git-less or plain-tsc builds fall back to the npm version. */
async function versionLine(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  let version = pkg.version;
  let build = '';
  try {
    const bi = JSON.parse(await readFile(new URL('./buildinfo.json', import.meta.url), 'utf8')) as {
      version?: string | null;
      commit?: string | null;
      date?: string | null;
    };
    if (bi.version) version = bi.version;
    const parts = [bi.commit, bi.date?.slice(0, 10)].filter(Boolean);
    if (parts.length > 0) build = ` (${parts.join(', ')})`;
  } catch {
    // no buildinfo baked — version only
  }
  return `artipod ${version}${build}`;
}

async function main(): Promise<void> {
  const parsed = parseArgs(argv.slice(2));
  if ('help' in parsed) {
    stdout.write(`${await versionLine()} — a pod for artifacts\n\n${HELP}`);
    return;
  }
  if ('version' in parsed) {
    stdout.write(`${await versionLine()}\n`);
    return;
  }
  if ('pods' in parsed) {
    await listPods(resolve(parsed.podsRoot));
    return;
  }
  if ('removeIds' in parsed) {
    await removePods(resolve(parsed.podsRoot), parsed.removeIds);
    return;
  }
  if ('prune' in parsed) {
    await prunePods(resolve(parsed.podsRoot), parsed.force, parsed.all);
    return;
  }
  if ('importDir' in parsed) {
    await importDirectory(parsed.importDir, parsed.importRef, parsed.store);
    return;
  }
  if ('serve' in parsed) {
    // Lazy import (dockerode value-isolation pattern): `artipod run` never pays for server code.
    const { runServe } = await import('./server/serve.js');
    await runServe(parsed.serve);
    return;
  }

  if (!parsed.command && !parsed.interactive) {
    stdout.write('artipod run: nothing to do (no -c command and stdin is not a TTY) — did you mean -it?\n');
    exit(2);
  }
  // Bad --base/-v paths fail here, before a kept pod dir is minted.
  for (const base of parsed.bases) await assertDirectory('run --base', parseBaseSpec(base).dir);
  for (const vol of parsed.volumes) await assertDirectory('run -v', parseVolumeSpec(vol).dir);

  const loc = await resolvePodLocation(parsed);
  if (loc.resumed) parsed.ref = undefined;
  const pod = await bootPod(parsed, loc.dir);
  if (loc.kept) await touchSuperblock(pod);
  // Create-on-write: fingerprint a fresh kept pod after boot; if the run
  // mutates nothing (REF materialization counts), the dir is removed at exit.
  const baseline = loc.kept && !loc.resumed && !parsed.dir && loc.dir ? await dirState(loc.dir) : null;
  if (parsed.ref) await materializeRef(pod, parsed);
  if (parsed.bases.length > 0) await materializeBases(pod, parsed);

  const done = async (code: number): Promise<never> => {
    if (loc.cleanup && loc.dir) await rm(loc.dir, { recursive: true, force: true });
    if (baseline && loc.dir && sameState(baseline, await dirState(loc.dir))) {
      await rm(loc.dir, { recursive: true, force: true });
      if (parsed.interactive) stdout.write(`pod ${basename(loc.dir)} untouched — not kept\n`);
    } else if (loc.kept && loc.dir && parsed.interactive) {
      const back = parsed.dir
        ? `artipod run -it --dir ${tildify(loc.dir)}`
        : `artipod run -it ${basename(loc.dir).slice(0, 8)}`;
      const tags = parsed.dir ? [] : await podTags(loc.dir);
      stdout.write(`pod ${basename(loc.dir)} kept${tags.length > 0 ? ` (${tags.join(', ')})` : ''} — get back: ${back}\n`);
      if (!parsed.dir && tags.length === 0) {
        stdout.write('untagged — `artipod prune` removes untagged pods; tag inside the shell: artipod commit --tag <name>:<tag>\n');
      }
    }
    exit(code);
  };

  if (parsed.command) {
    const sandbox = pod.createSandbox();
    const r = await sandbox.exec(parsed.command);
    if (r.stdout) stdout.write(r.stdout);
    if (r.stderr) stdout.write(r.stderr);
    pod.dispose();
    return done(r.exitCode);
  }

  return done(await repl(pod, bannerNote(parsed, loc)));
}

main().catch((e: unknown) => {
  stdout.write(`artipod: ${e instanceof Error ? e.message : String(e)}\n`);
  exit(1);
});
