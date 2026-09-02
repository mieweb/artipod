/**
 * `artipod serve` implementation (serve plan S0) — lazily imported from the
 * CLI so `artipod run` never pays for server code. One store, one
 * createArtipodApp, one node adapter; policy arrives as flags/env.
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import process, { env, stdout } from 'node:process';
import { OciLayoutPodStore } from '../manager/pod-store.js';
import { PodSessionHost } from '../manager/session-host.js';
import { nodePodFs } from '../nodePodFs.js';
import { bearerAuth } from './common.js';
import { createArtipodApp } from './app.js';
import { serveApp } from './node.js';

export interface ServeCliOptions {
  port: number;
  host: string;
  store: string;
  only?: 'web' | 'registry';
  cors: string[];
  ociAllow: string[];
  exec: boolean;
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

export async function runServe(opts: ServeCliOptions): Promise<void> {
  const storeDir = resolve(opts.store);
  const store = new OciLayoutPodStore(nodePodFs(), storeDir);
  await store.init();

  const surfaces = { web: opts.only !== 'registry', registry: opts.only !== 'web' };
  const relayHosts = opts.ociAllow.length > 0 ? opts.ociAllow : envList('ARTIPOD_OCI_ALLOWED_HOSTS');

  const app = createArtipodApp({
    store,
    surfaces,
    cors: opts.cors,
    relay: { allowedHosts: relayHosts },
    exec:
      opts.exec && surfaces.web
        ? {
            host: new PodSessionHost({
              ttlMs: 15 * 60_000,
              maxSessions: 50,
              execTimeoutMs: 30_000,
              maxFsBytes: 256 * 1024 * 1024,
            }),
            auth: bearerAuth(() => env.EXEC_API_TOKEN),
          }
        : false,
  });

  const { url, close } = await serveApp(app, { port: opts.port, host: opts.host });

  const refs = await store.listRefs();
  const tildify = (p: string): string => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);
  stdout.write(`artipod serve listening at ${url}\n`);
  stdout.write(`  store:    ${tildify(storeDir)} (${refs.length} ref${refs.length === 1 ? '' : 's'})\n`);
  stdout.write(
    `  surfaces: ${[surfaces.web && 'web (/api)', surfaces.registry && 'registry (/v2 — arrives S3)']
      .filter(Boolean)
      .join(', ')}\n`,
  );
  if (relayHosts.length > 0) stdout.write(`  relay:    ${relayHosts.join(', ')}\n`);
  stdout.write('press Ctrl-C to stop\n');

  await new Promise<void>((resolveDone) => {
    const stop = (): void => {
      void close().finally(resolveDone);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
