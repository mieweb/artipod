#!/usr/bin/env node
/**
 * The artipod CLI: `artipod run -it [REF]` boots a pod and drops you into an
 * artipod-bash — the same sandbox the browser and agents use, with the
 * `artipod` verbs (snapshot/commit/push/pull/clone/…) wired to a local
 * OCI-layout store and, for image refs, the public registries.
 *
 * Ephemeral by default (docker `run` semantics); `--dir` persists the pod on
 * the real filesystem. REF materializes the ref's merged view into the
 * writable root (clone semantics — layered base+upper `run` arrives with
 * manifest root.image realization).
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { stdin, stdout, exit, argv, env } from 'node:process';
import { createZenFsPod, type ZenFsPod } from './realize/zenfs.js';
import type { PodManifest } from './manifest.js';
import { OciLayoutPodStore } from './manager/pod-store.js';
import { storeTransport, materializeImage } from './manager/sync.js';
import { DirectRegistryTransport, parseImageRef, formatImageRef } from './oci/transport.js';
import { pullImage } from './oci/pull.js';
import { nodePodFs } from './nodePodFs.js';

const HELP = `artipod — a pod for artifacts

usage:
  artipod run [-it] [REF] [flags]     boot a pod (empty, or materialized from REF)
  artipod --help | --version

flags for run:
  -i, -t, -it        interactive shell (default when stdin is a TTY and no -c)
  -c <command>       run one shell line and exit with its code
  --dir <path>       persist the pod at <path> on the real fs (default: ephemeral, in-memory)
  --store <path>     local OCI-layout store used by push/pull/clone and REF lookup
                     (default: ~/.artipod/store, env ARTIPOD_STORE)
  --registry         resolve REF via the public registry even if the store has it
  --at <path>        where REF materializes (default: '/' for artipod volume refs,
                     '/rootfs' for container images — their ELF binaries can't run in
                     artipod-bash, so the shell's builtins stay resolvable)

REF examples:
  artipod run -it                      # fresh empty pod
  artipod run -it alpine:3.22          # registry image, cloned into the pod root
  artipod run -it field/notes:1        # a ref you pushed earlier (from --store)

inside the shell, run \`artipod\` for the pod verbs (snapshot, commit, push, …).
`;

interface RunArgs {
  ref?: string;
  interactive: boolean;
  command?: string;
  dir?: string;
  store: string;
  forceRegistry: boolean;
  at?: string;
}

function parseArgs(args: string[]): RunArgs | { help: true } | { version: true } {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) return { help: true };
  if (args.includes('--version')) return { version: true };
  const [verb, ...rest] = args;
  if (verb !== 'run') {
    stdout.write(`artipod: unknown command '${verb}' (the pod verbs live INSIDE the shell — try: artipod run -it)\n\n${HELP}`);
    exit(2);
  }
  const out: RunArgs = {
    interactive: false,
    store: env.ARTIPOD_STORE ?? resolve(homedir(), '.artipod/store'),
    forceRegistry: false,
  };
  let sawInteractiveFlag = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-i' || a === '-t' || a === '-it' || a === '-ti') sawInteractiveFlag = true;
    else if (a === '-c') out.command = rest[++i];
    else if (a === '--dir') out.dir = rest[++i];
    else if (a === '--store') out.store = rest[++i];
    else if (a === '--at') out.at = rest[++i];
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
  out.interactive = sawInteractiveFlag || (!out.command && stdin.isTTY === true);
  return out;
}

async function bootPod(args: RunArgs): Promise<ZenFsPod> {
  if (args.dir) await mkdir(resolve(args.dir), { recursive: true });
  const manifest: PodManifest = {
    formatVersion: 1,
    mounts: [
      args.dir
        ? { name: 'work', path: '/', mode: 'rw', source: { kind: 'hostDir', dir: resolve(args.dir) } }
        : { name: 'work', path: '/', mode: 'rw', source: { kind: 'backend', backend: 'memory' } },
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

/** Materialize REF into the pod: store-first, registry fallback. Volume refs
 * land at '/'; container images at '/rootfs' (their binaries are ELF — they'd
 * shadow artipod-bash's builtins via PATH without ever being runnable). */
async function materializeRef(pod: ZenFsPod, args: RunArgs): Promise<void> {
  const ref = args.ref!;
  const store = new OciLayoutPodStore(nodePodFs(), resolve(args.store));
  await store.init();
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
    config?: { mediaType?: string };
  };
  const isVolume = manifest.config?.mediaType === 'application/vnd.artipod.volume.v1+json';
  const at = args.at ?? (isVolume ? '/' : '/rootfs');
  const result = await materializeImage({ store: pod.oci.store, zfs: pod.zfs, refOrDigest: pulled.manifestDigest, at });
  stdout.write(`materialized ${ref} at ${at}: ${result.files} files (writable)${at !== '/' ? ` — cd ${at}` : ''}\n`);
}

async function repl(pod: ZenFsPod): Promise<number> {
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
    '',
  ].join('\n');
  stdout.write(banner);

  return new Promise<number>((resolveExit) => {
    let lastCode = 0;
    let running = false;
    const queue: string[] = [];

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
      const next = queue.shift();
      if (next !== undefined) void handle(next);
      else prompt();
    };

    const handle = async (raw: string) => {
      const line = raw.trim();
      sigintArmed = false;
      if (line === 'exit' || line === 'logout') {
        rl.close();
        return;
      }
      if (!line) {
        prompt();
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
      stdout.write('\n');
      pod.dispose();
      resolveExit(lastCode);
    });

    prompt();
  });
}

async function main(): Promise<void> {
  const parsed = parseArgs(argv.slice(2));
  if ('help' in parsed) {
    stdout.write(HELP);
    return;
  }
  if ('version' in parsed) {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    stdout.write(`artipod ${pkg.version}\n`);
    return;
  }

  const pod = await bootPod(parsed);
  if (parsed.ref) await materializeRef(pod, parsed);

  if (parsed.command) {
    const sandbox = pod.createSandbox();
    const r = await sandbox.exec(parsed.command);
    if (r.stdout) stdout.write(r.stdout);
    if (r.stderr) stdout.write(r.stderr);
    pod.dispose();
    exit(r.exitCode);
  }

  if (!parsed.interactive) {
    stdout.write('artipod run: nothing to do (no -c command and stdin is not a TTY) — did you mean -it?\n');
    pod.dispose();
    exit(2);
  }

  exit(await repl(pod));
}

main().catch((e: unknown) => {
  stdout.write(`artipod: ${e instanceof Error ? e.message : String(e)}\n`);
  exit(1);
});
