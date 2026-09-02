/**
 * `artipod serve` implementation (serve plan S0/S1) — lazily imported from
 * the CLI so `artipod run` never pays for server code. One store, one
 * createArtipodApp, one node adapter; policy arrives as flags/env.
 */

import { randomBytes } from 'node:crypto';
import { homedir, hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process, { env, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { OciLayoutPodStore } from '../manager/pod-store.js';
import { PodSessionHost } from '../manager/session-host.js';
import { nodePodFs } from '../nodePodFs.js';
import { bearerAuth, json } from './common.js';
import { createArtipodApp, type ArtipodApp } from './app.js';
import { serveApp } from './node.js';
import { publishDirectory, materializeRef } from './folder.js';
import { PublishMap, withinRoots } from './publish-map.js';

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
  open: boolean;
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
<p>native sync surface: <code>${escapeHtml(url)}/api/pods</code> · registry: <code>${escapeHtml(url)}/v2/</code> (arrives S3)</p>
${refs.length > 0 ? `<h2>refs</h2><ul>${rows}</ul>` : '<p>no refs yet — <code>artipod serve --publish &lt;dir&gt;</code> or push one.</p>'}
<p>this is the headless landing — the full UI ships in serve plan S2.</p>
</body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/** Wrap every surface behind a bearer token (V7 — non-localhost auto-token path). */
function requireToken(app: ArtipodApp, token: string): ArtipodApp {
  return async (req) => {
    if (req.headers.get('authorization') === `Bearer ${token}`) return app(req);
    if (req.method.toUpperCase() === 'OPTIONS') return app(req); // preflights carry no credentials
    return json(
      { error: 'unauthorized', hint: 'Authorization: Bearer <token> — the token was printed at serve startup' },
      401,
    );
  };
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

export async function runServe(opts: ServeCliOptions): Promise<void> {
  const storeDir = resolve(opts.store);
  const store = new OciLayoutPodStore(nodePodFs(), storeDir);
  await store.init();

  const surfaces = { web: opts.only !== 'registry', registry: opts.only !== 'web' };
  const relayHosts = opts.ociAllow.length > 0 ? opts.ociAllow : envList('ARTIPOD_OCI_ALLOWED_HOSTS');

  // V7: localhost stays open; a non-localhost bind with no token configured
  // generates one (Jupyter-style) and requires it on every surface.
  let token = opts.token ?? env.ARTIPOD_SERVE_TOKEN;
  let tokenGenerated = false;
  if (!token && !LOCAL_HOSTS.has(opts.host)) {
    token = randomBytes(16).toString('hex');
    tokenGenerated = true;
  }

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

  const app = createArtipodApp({
    store,
    surfaces,
    cors: opts.cors,
    relay: { allowedHosts: relayHosts },
    onRefPut,
    exec:
      opts.exec && surfaces.web
        ? {
            host: new PodSessionHost({
              ttlMs: 15 * 60_000,
              maxSessions: 50,
              execTimeoutMs: 30_000,
              maxFsBytes: 256 * 1024 * 1024,
            }),
            auth: bearerAuth(() => env.EXEC_API_TOKEN ?? token),
          }
        : false,
    fallback: surfaces.web
      ? async (req) => landingPage(storeDir, await store.listRefs(), new URL(req.url).origin)
      : undefined,
  });
  const guarded = token ? requireToken(app, token) : app;

  const { url, close } = await serveApp(guarded, { port: opts.port, host: opts.host });

  const refs = await store.listRefs();
  const tildify = (p: string): string => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
  stdout.write(`artipod serve listening at ${url}\n`);
  stdout.write(`  store:    ${tildify(storeDir)} (${refs.length} ref${refs.length === 1 ? '' : 's'})\n`);
  stdout.write(
    `  surfaces: ${[surfaces.web && 'web (/api)', surfaces.registry && 'registry (/v2 — arrives S3)']
      .filter(Boolean)
      .join(', ')}\n`,
  );
  for (const line of published) stdout.write(`  publish:  ${line}\n`);
  if (relayHosts.length > 0) stdout.write(`  relay:    ${relayHosts.join(', ')}\n`);
  if (token) {
    stdout.write(`  token:    ${tokenGenerated ? `${token} (generated — non-localhost bind)` : 'configured'}\n`);
    stdout.write(`            every request needs: Authorization: Bearer <token>\n`);
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
