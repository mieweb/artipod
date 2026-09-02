/**
 * `artipod serve` implementation (serve plan S0/S1) — lazily imported from
 * the CLI so `artipod run` never pays for server code. One store, one
 * createArtipodApp, one node adapter; policy arrives as flags/env.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process, { env, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { digestHex } from '../oci/digest.js';
import { OciLayoutPodStore } from '../manager/pod-store.js';
import { PodSessionHost } from '../manager/session-host.js';
import { nodePodFs } from '../nodePodFs.js';
import { bearerAuth, staticTokenAuth } from './common.js';
import { createArtipodApp } from './app.js';
import { serveApp } from './node.js';
import { publishDirectory, materializeRef } from './folder.js';
import { PublishMap, withinRoots } from './publish-map.js';
import { UI_REF, UI_DIGEST, UI_REMOTE_REF } from './ui-ref.js';

export interface ServeCliOptions {
  port: number;
  host: string;
  store: string;
  only?: 'web' | 'registry';
  cors: string[];
  ociAllow: string[];
  exec: boolean;
  /** Host folders published at boot with write-back on push (S1). */
  publish: string[];
  token?: string;
  readToken?: string;
  /** Refs to lock/unlock at boot (persisted in <store>/locks.json). */
  lock: string[];
  unlock: string[];
  open: boolean;
  /** false = --no-ui (headless landing). */
  ui: boolean;
}

export const DEFAULT_SERVE_PORT = 2784; // "ARTI" on a keypad (V7)

export function defaultStoreDir(): string {
  return env.ARTIPOD_STORE ?? resolve(homedir(), '.artipod/store');
}

function envList(name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** Locked tags (tag immutability): <store>/locks.json, applied via --lock/--unlock. */
async function loadLocks(storeDir: string, lock: string[], unlock: string[]): Promise<Set<string>> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const file = join(storeDir, 'locks.json');
  let locks = new Set<string>();
  try {
    locks = new Set(JSON.parse(await readFile(file, 'utf8')) as string[]);
  } catch {
    // no locks yet
  }
  if (lock.length > 0 || unlock.length > 0) {
    for (const ref of lock) locks.add(ref);
    for (const ref of unlock) locks.delete(ref);
    await writeFile(file, `${JSON.stringify([...locks].sort(), null, 2)}\n`);
  }
  return locks;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Headless landing at `/` (S1): served refs, store path, copy-paste lines. */
function landingPage(storeDir: string, refs: { ref: string }[], url: string): Response {
  const rows = refs
    .map(
      (r) =>
        `<li><code>${escapeHtml(r.ref)}</code> — <code>curl '${escapeHtml(url)}/api/pods/refs?name=${encodeURIComponent(r.ref)}'</code></li>`,
    )
    .join('\n');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>artipod serve</title>
<style>body{font-family:ui-monospace,monospace;max-width:48rem;margin:3rem auto;padding:0 1rem;line-height:1.5}code{background:#f0f0f0;padding:.1em .3em;border-radius:3px}</style>
</head><body>
<h1>artipod serve</h1>
<p>store: <code>${escapeHtml(storeDir)}</code></p>
<p>native sync surface: <code>${escapeHtml(url)}/api/pods</code> · registry pull: <code>docker pull ${escapeHtml(url.replace(/^https?:\/\//, ''))}/&lt;name&gt;:&lt;tag&gt;</code></p>
${refs.length > 0 ? `<h2>refs</h2><ul>${rows}</ul>` : '<p>no refs yet — <code>artipod serve --publish &lt;dir&gt;</code> or push one.</p>'}
<h2>get the full UI</h2>
<p>this is the headless landing — no <code>artipod-ui:latest</code> in the store yet. The full
terminal/editor UI (press <kbd>ctrl+\`</kbd> there to toggle the terminal) is one import away:</p>
<pre>cd examples/artipod-sync &amp;&amp; npm run export:static   # build the static UI → out/
artipod import out artipod-ui:latest                 # into this store
# restart artipod serve — the UI is served at / from then on</pre>
<p>or point <code>ARTIPOD_UI_DIR</code> at any static build (dev loop), or hide this page with <code>--no-ui</code>.</p>
</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

/**
 * UI resolution, LOCAL-FIRST (S2): ARTIPOD_UI_DIR (a local build) →
 * ARTIPOD_UI_REF/UI_REF in the local store (materialized once into
 * ~/.artipod/ui/<digest>) → remote fetch of the digest pin (dormant while
 * UI_DIGEST is null) → headless landing. Never an error.
 */
async function resolveUiDir(store: OciLayoutPodStore): Promise<{ dir: string; source: string } | null> {
  const resolved = await resolveUiDirInner(store);
  if (resolved) await warnOnVersionSkew(resolved.dir);
  return resolved;
}

/** ui-buildinfo.json is baked by export-static.mjs — a UI bundling an older core than the serve is stale. */
async function warnOnVersionSkew(uiDir: string): Promise<void> {
  try {
    const { readFile } = await import('node:fs/promises');
    const info = JSON.parse(await readFile(join(uiDir, 'ui-buildinfo.json'), 'utf8')) as { coreVersion?: string };
    // Compose our own full version the same way export-static does — skew
    // detection is commit-precise on dev builds.
    const own = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    let ownFull = own.version ?? '';
    try {
      const bi = JSON.parse(await readFile(new URL('../buildinfo.json', import.meta.url), 'utf8')) as {
        version?: string;
        commit?: string;
        date?: string;
      };
      ownFull = `${bi.version ?? ownFull} (${bi.commit ?? 'no-git'}, ${(bi.date ?? '').slice(0, 10)})`;
    } catch {
      // gitless build — compare plain versions
    }
    if (info.coreVersion && ownFull && info.coreVersion !== ownFull) {
      stdout.write(
        `warning: the UI bundles @artipod/core ${info.coreVersion} but this serve is ${ownFull} — rebuild it: cd examples/artipod-sync && npm run export:static && artipod import out artipod-ui:latest\n`,
      );
    }
  } catch {
    // pre-buildinfo UI or no package.json beside dist — nothing to compare
  }
}

async function resolveUiDirInner(store: OciLayoutPodStore): Promise<{ dir: string; source: string } | null> {
  if (env.ARTIPOD_UI_DIR) {
    const dir = resolve(env.ARTIPOD_UI_DIR);
    try {
      await stat(join(dir, 'index.html'));
      return { dir, source: 'ARTIPOD_UI_DIR' };
    } catch {
      stdout.write(`warning: ARTIPOD_UI_DIR=${dir} has no index.html — ignoring\n`);
    }
  }
  const ref = env.ARTIPOD_UI_REF ?? UI_REF;
  const stored = await store.getRef(ref);
  if (stored) {
    const dir = resolve(homedir(), '.artipod/ui', digestHex(stored.manifestDigest));
    try {
      await stat(join(dir, 'index.html')); // cached materialization
    } catch {
      await mkdir(dir, { recursive: true }); // materializeRef realpaths the target
      await materializeRef(store, ref, dir);
    }
    return { dir, source: `${ref} (store)` };
  }
  if (UI_DIGEST) {
    // Remote fetch of the pinned artifact (release step publishes
    // UI_REMOTE_REF and bumps UI_DIGEST). Not reachable until a pin exists.
    stdout.write(`note: UI artifact ${UI_REMOTE_REF}@${UI_DIGEST} not in the local store — remote fetch not implemented yet, serving headless\n`);
  }
  return null;
}

export async function runServe(opts: ServeCliOptions): Promise<void> {
  const storeDir = resolve(opts.store);
  const store = new OciLayoutPodStore(nodePodFs(), storeDir);
  await store.init();

  const surfaces = { web: opts.only !== 'registry', registry: opts.only !== 'web' };
  const relayHosts = opts.ociAllow.length > 0 ? opts.ociAllow : envList('ARTIPOD_OCI_ALLOWED_HOSTS');

  // V7: localhost stays open; a non-localhost bind with no token configured
  // generates one (Jupyter-style) and requires it on every surface. S5:
  // static ro/rw tokens via Bearer or Basic (docker login works).
  let token = opts.token ?? env.ARTIPOD_SERVE_TOKEN;
  const readToken = opts.readToken ?? env.ARTIPOD_SERVE_READ_TOKEN;
  let tokenGenerated = false;
  if (!token && !readToken && !LOCAL_HOSTS.has(opts.host)) {
    token = randomBytes(16).toString('hex');
    tokenGenerated = true;
  }
  const auth = token || readToken ? staticTokenAuth({ rw: () => token, ro: () => readToken }) : undefined;

  // --publish (S1): snapshot each folder at boot, remember ref → dir, and
  // write pushed heads back. The dirs themselves are the roots allowlist
  // (plus env), re-checked on every materialize — the map is data, not
  // authority.
  const publishMap = new PublishMap(join(storeDir, 'publish-map.json'));
  const publishRoots = [...opts.publish.map((d) => resolve(d)), ...envList('ARTIPOD_PUBLISH_ROOTS')];
  const published: string[] = [];
  for (const dir of opts.publish) {
    const abs = resolve(dir);
    const ref = `${basename(abs)}:latest`;
    const result = await publishDirectory(store, abs, ref, { actor: `serve:${hostname()}` });
    await publishMap.record(ref, abs);
    published.push(
      `${ref} ← ${abs} (${result.layers} layer${result.layers === 1 ? '' : 's'}${result.unchanged ? ', unchanged' : ''})`,
    );
  }
  const onRefPut =
    surfaces.web && publishRoots.length > 0
      ? async (ref: string): Promise<void> => {
          const dir = await publishMap.dirFor(ref);
          if (!dir) return;
          const real = await withinRoots(dir, publishRoots);
          if (!real) return;
          await materializeRef(store, ref, real);
        }
      : undefined;

  const uiInfo = opts.ui && surfaces.web ? await resolveUiDir(store) : null;
  const locks = await loadLocks(storeDir, opts.lock, opts.unlock);

  const app = createArtipodApp({
    store,
    surfaces,
    auth,
    cors: opts.cors,
    relay: { allowedHosts: relayHosts },
    onRefPut,
    isLocked: locks.size > 0 ? (ref) => locks.has(ref) : undefined,
    exec:
      opts.exec && surfaces.web
        ? {
            host: new PodSessionHost({
              ttlMs: 15 * 60_000,
              maxSessions: 50,
              execTimeoutMs: 30_000,
              maxFsBytes: 256 * 1024 * 1024,
            }),
            // EXEC_API_TOKEN overrides; otherwise exec rides the app auth (rw)
            ...(env.EXEC_API_TOKEN ? { auth: bearerAuth(() => env.EXEC_API_TOKEN) } : {}),
          }
        : false,
    ui: uiInfo ? { dir: uiInfo.dir } : false,
    fallback: surfaces.web
      ? async (req) => landingPage(storeDir, await store.listRefs(), new URL(req.url).origin)
      : undefined,
  });

  const { url, close } = await serveApp(app, { port: opts.port, host: opts.host });

  const refs = await store.listRefs();
  const tildify = (p: string): string => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
  stdout.write(`artipod serve listening at ${url}\n`);
  stdout.write(`  store:    ${tildify(storeDir)} (${refs.length} ref${refs.length === 1 ? '' : 's'})\n`);
  stdout.write(
    `  surfaces: ${[surfaces.web && 'web (/api)', surfaces.registry && 'registry (/v2, pull)']
      .filter(Boolean)
      .join(', ')}\n`,
  );
  for (const line of published) stdout.write(`  publish:  ${line}\n`);
  if (locks.size > 0) stdout.write(`  locked:   ${[...locks].sort().join(', ')} (tags cannot move — --unlock <ref> to release)\n`);
  if (uiInfo) stdout.write(`  ui:       ${uiInfo.source} — ${tildify(uiInfo.dir)}\n`);
  if (relayHosts.length > 0) stdout.write(`  relay:    ${relayHosts.join(', ')}\n`);
  if (token || readToken) {
    if (token) {
      stdout.write(`  token:    ${tokenGenerated ? `${token} (generated — non-localhost bind)` : 'configured (rw)'}\n`);
    }
    if (readToken) stdout.write(`  ro-token: configured (read-only)\n`);
    stdout.write(`            send as 'Authorization: Bearer <token>' or Basic (docker login: any user, token as password)\n`);
  }
  stdout.write('press Ctrl-C to stop\n');
  if (opts.open) openBrowser(url);

  await new Promise<void>((resolveDone) => {
    const stop = (): void => {
      void close().finally(resolveDone);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
