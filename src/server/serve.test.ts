/**
 * `artipod serve` smoke test (serve plan S0): spawns dist/cli.js — CI builds
 * before test (same rule as cli.test.ts). --port 0, parse the printed URL,
 * exercise refs + a blob round trip over real HTTP, SIGTERM clean exit.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256 } from '../oci/digest.js';

const CLI = resolve(import.meta.dirname, '../../dist/cli.js');
const scratch: string[] = [];
const children: ChildProcess[] = [];
afterAll(async () => {
  for (const c of children) c.kill('SIGKILL');
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
});

async function startServe(args: string[] = []): Promise<{ url: string; child: ChildProcess; exited: Promise<number | null> }> {
  const storeDir = await mkdtemp(join(tmpdir(), 'apod-serve-store-'));
  scratch.push(storeDir);
  const child = spawn('node', [CLI, 'serve', '--port', '0', '--store', storeDir, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const exited = new Promise<number | null>((r) => child.once('exit', r));
  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    let out = '';
    const timer = setTimeout(() => rejectUrl(new Error(`serve never printed a URL:\n${out}`)), 30_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const m = /listening at (http:\/\/[^\s]+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[1]);
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    void exited.then(() => rejectUrl(new Error(`serve exited early:\n${out}`)));
  });
  return { url, child, exited };
}

describe('artipod serve', () => {
  it('serves refs + blobs, denies the relay by default, and exits cleanly on SIGTERM', async () => {
    const { url, child, exited } = await startServe();

    // empty refs list
    const refs = await fetch(`${url}/api/pods/refs`);
    expect(refs.status).toBe(200);
    expect(await refs.json()).toEqual([]);

    // blob round trip
    const bytes = new TextEncoder().encode('served blob bytes');
    const digest = await sha256(bytes);
    const put = await fetch(`${url}/api/pods/blobs/${digest}`, { method: 'PUT', body: bytes });
    expect(put.status).toBe(201);
    const got = await fetch(`${url}/api/pods/blobs/${digest}`);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);

    // relay: deny-all without --oci-allow
    const relay = await fetch(`${url}/api/oci/registry-1.docker.io/v2/`);
    expect(relay.status).toBe(403);

    // git proxy preflight answers with CORS
    const preflight = await fetch(`${url}/api/git/github.com/x/y/info/refs`, { method: 'OPTIONS' });
    expect(preflight.status).toBe(204);

    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 60_000);

  it('--only registry turns the web surface off', async () => {
    const { url, child, exited } = await startServe(['--only', 'registry']);
    const res = await fetch(`${url}/api/pods/refs`);
    expect(res.status).toBe(404);
    child.kill('SIGTERM');
    await exited;
  }, 60_000);
});
