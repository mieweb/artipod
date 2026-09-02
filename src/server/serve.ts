/**
 * `artipod serve` implementation (serve plan S0/S1) — lazily imported from
 * the CLI so `artipod run` never pays for server code. One store, one
 * createArtipodApp, one node adapter; policy arrives as flags/env.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process, { env, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { digestHex } from '../oci/digest.js';
import { importBlobKey } from '../oci/cipher.js';
import { OciLayoutPodStore } from '../manager/pod-store.js';
import { PodSessionHost } from '../manager/session-host.js';
import type { Authority } from '../manager/authority.js';
import { nodePodFs } from '../nodePodFs.js';
import { bearerAuth, staticTokenAuth } from './common.js';
import { createArtipodApp } from './app.js';
import { serveApp } from './node.js';
import { publishDirectory, materializeRef } from './folder.js';
import { PublishMap, withinRoots } from './publish-map.js';
import { loadOrCreateAuthority, ensurePodKek } from './authority-dir.js';
import { DEFAULT_KEY_TTL_MS } from './keys-handler.js';
import { UI_REF } from './ui-ref.js';

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
  /** Tag regex: matching tags are create-once (sealed on first push). Default: '^[^_]'. */
  sealPattern?: string;
  /** Disable seal enforcement entirely (classic mutable-tag registry). */
  noSeal?: boolean;
  open: boolean;
  /** false = --no-ui (headless landing). */
  ui: boolean;
  /** Broker mode (S5.5): encrypt the store at rest + serve /api/keys. */
  encrypt?: boolean;
  /** Lease TTL cap for /api/keys logins: <n>(ms|s|m|h|d). Default 1h (V10). */
  keyTtl?: string;
  /** Authority home (signing key + raw pod KEKs, 0700). Default ~/.artipod/authority. */
  authority?: string;
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

export const KEY_TTL_RE = /^(\d+)(ms|s|m|h|d)?$/;
const TTL_UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** '1h' / '30m' / '90s' / bare seconds → ms; null on nonsense. */
export function parseKeyTtl(spec: string): number | null {
  const match = KEY_TTL_RE.exec(spec.trim());
  if (!match) return null;
  const ms = Number(match[1]) * TTL_UNIT_MS[match[2] ?? 's'];
  return ms > 0 ? ms : null;
}

/** The served store's stable pod identity (lease scope): <store>/store-id.json. */
async function loadOrCreateStoreId(storeDir: string): Promise<string> {
  const file = join(storeDir, 'store-id.json');
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { podId?: string };
    if (parsed.podId) return parsed.podId;
  } catch {
    // first --encrypt on this store
  }
  const podId = randomBytes(8).toString('hex');
  await writeFile(file, `${JSON.stringify({ podId }, null, 2)}\n`);
  return podId;
}

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
<p>this is the headless landing — this build carries no bundled UI (npm installs do;
a dev checkout builds it once):</p>
<pre>npm run build:ui        # exports the demo → dist-ui/ (served at / after restart)</pre>
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
 * ~/.artipod/ui/<digest>) → bundled dist-ui in the npm package →
 * headless landing. Never an error.
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
  // Bundled UI: the npm package ships the static build at <pkg>/dist-ui, so
  // `npx artipod serve` is batteries-included offline. A store ref or
  // ARTIPOD_UI_DIR (above) always wins — they are deliberate overrides.
  try {
    const bundled = fileURLToPath(new URL('../../dist-ui', import.meta.url));
    await stat(join(bundled, 'index.html'));
    return { dir: bundled, source: 'bundled (dist-ui)' };
  } catch {
    // dev checkout without a built dist-ui — headless landing
  }
  return null;
}

export async function runServe(opts: ServeCliOptions): Promise<void> {
  const storeDir = resolve(opts.store);
  const store = new OciLayoutPodStore(nodePodFs(), storeDir);
  await store.init();

  // --encrypt (S5.5, V9 broker): load-or-create the authority + this store's
  // KEK BEFORE anything writes blobs, so the first --publish already lands
  // as ciphertext. The serve holds the key — it can decrypt what it brokers.
  let broker: { authority: Authority; podId: string; capTtlMs: number; dir: string; created: boolean } | null = null;
  if (opts.encrypt) {
    const capTtlMs = opts.keyTtl ? parseKeyTtl(opts.keyTtl) : DEFAULT_KEY_TTL_MS;
    if (capTtlMs === null) {
      stdout.write(`artipod serve: invalid --key-ttl '${opts.keyTtl}' — want <n>(ms|s|m|h|d), e.g. 1h\n`);
      process.exit(2);
    }
    const dir = resolve(opts.authority ?? join(homedir(), '.artipod/authority'));
    const { authority, created } = await loadOrCreateAuthority(dir, `serve:${hostname()}`);
    const podId = await loadOrCreateStoreId(storeDir);
    const { kek } = await ensurePodKek(dir, authority, podId);
    store.enableEncryption(await importBlobKey(kek));
    broker = { authority, podId, capTtlMs, dir, created };
  }

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
  // Seal enforcement (dossier pattern) is ON BY DEFAULT: any tag not
  // starting with `_` is create-once — the name declares the lifecycle
  // (`_` = open draft, everything else = sealed milestone). --no-seal
  // restores classic mutable tags; --seal-pattern narrows the rule.
  const sealRaw = opts.noSeal ? undefined : (opts.sealPattern ?? env.ARTIPOD_SEAL_PATTERN ?? '^[^_]');
  const sealRe = sealRaw ? new RegExp(sealRaw) : null;
  const isLocked =
    locks.size > 0 || sealRe
      ? async (ref: string): Promise<boolean> => {
          if (locks.has(ref)) return true;
          if (!sealRe) return false;
          // --publish refs are living folder mirrors — write-back is their point
          if (await publishMap.dirFor(ref)) return false;
          const tag = ref.slice(ref.lastIndexOf(':') + 1);
          return sealRe.test(tag) && !!(await store.getRef(ref));
        }
      : undefined;

  const app = createArtipodApp({
    store,
    surfaces,
    auth,
    cors: opts.cors,
    relay: { allowedHosts: relayHosts },
    onRefPut,
    isLocked,
    keys: broker
      ? { authority: broker.authority, podIds: [broker.podId], capTtlMs: broker.capTtlMs }
      : undefined,
    // The operations journal: every ref move/delete, append-only JSONL beside
    // the store. The parents DAG keeps the DATA recoverable; this keeps the
    // STORY — who moved what, when, from where to where.
    onRefOp: async (op) => {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(join(storeDir, 'ref-log.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...op })}\n`).catch(() => {});
    },
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
  if (sealRe) stdout.write(`  sealed:   tags matching /${sealRaw}/ are create-once (immutable after first push; _-tags stay open — --no-seal to disable)\n`);
  if (uiInfo) stdout.write(`  ui:       ${uiInfo.source} — ${tildify(uiInfo.dir)}\n`);
  if (broker) {
    stdout.write(`  keys:     broker ON — store encrypted at rest; THE SERVE MACHINE CAN DECRYPT WHAT IT BROKERS\n`);
    stdout.write(
      `            authority ${tildify(broker.dir)}${broker.created ? ' (created)' : ''} · pod ${broker.podId} · lease cap ${opts.keyTtl ?? '1h'}\n`,
    );
    stdout.write(`            login: POST ${url}/api/keys/login → lease + KEK · /v2 is off while encrypted\n`);
  }
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
