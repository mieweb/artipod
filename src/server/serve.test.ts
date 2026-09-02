/**
 * `artipod serve` smoke test (serve plan S0): spawns dist/cli.js — CI builds
 * before test (same rule as cli.test.ts). --port 0, parse the printed URL,
 * exercise refs + a blob round trip over real HTTP, SIGTERM clean exit.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function startServe(
  args: string[] = [],
  opts: { env?: Record<string, string>; storeDir?: string } = {},
): Promise<{ url: string; child: ChildProcess; exited: Promise<number | null>; output: () => string }> {
  const storeDir = opts.storeDir ?? (await mkdtemp(join(tmpdir(), 'apod-serve-store-')));
  scratch.push(storeDir);
  const child = spawn('node', [CLI, 'serve', '--port', '0', '--store', storeDir, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...opts.env },
  });
  children.push(child);
  const exited = new Promise<number | null>((r) => child.once('exit', r));
  let out = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  const url = await new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => rejectUrl(new Error(`serve never printed a URL:\n${out}`)), 30_000);
    const probe = (): void => {
      const m = /listening at (http:\/\/[^\s]+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[1]);
      }
    };
    child.stdout!.on('data', probe);
    void exited.then(() => rejectUrl(new Error(`serve exited early:\n${out}`)));
  });
  return { url, child, exited, output: () => out };
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

  it('serves the headless landing page at / with --no-ui', async () => {
    // without --no-ui a dev checkout may carry a bundled dist-ui — the landing
    // is the explicit-headless (and no-UI-resolvable) fallback
    const { url, child, exited } = await startServe(['--no-ui']);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('artipod serve');
    child.kill('SIGTERM');
    await exited;
  }, 60_000);

  it('--publish: folder → ref at boot, pushed heads materialize back (write-back e2e)', async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), 'apod-serve-pub-'));
    const clientDir = await mkdtemp(join(tmpdir(), 'apod-serve-client-'));
    scratch.push(scratchRoot, clientDir);
    // lowercase folder name — it becomes the OCI repo name on /v2
    const served = join(scratchRoot, 'my-notes');
    await mkdir(served);
    await writeFile(join(served, 'note.md'), 'original content\n');
    const ref = 'my-notes:latest';

    const { url, child, exited } = await startServe(['--publish', served]);

    // boot publish visible as a ref
    const refs = (await (await fetch(`${url}/api/pods/refs`)).json()) as { ref: string }[];
    expect(refs.map((r) => r.ref)).toContain(ref);

    // client edits a copy and pushes over the native surface
    await writeFile(join(clientDir, 'note.md'), 'edited by the client\n');
    const { HttpPodStore } = await import('../manager/http-store.js');
    const { publishDirectory } = await import('./folder.js');
    const remote = new HttpPodStore(`${url}/api/pods`);
    await publishDirectory(remote, clientDir, ref, { actor: 'client:test' });

    // write-back: the pushed head materialized into the served folder
    expect(await readFile(join(served, 'note.md'), 'utf8')).toBe('edited by the client\n');

    // the published ref is also visible through the /v2 distribution surface (S3)
    const ping = await fetch(`${url}/v2/`);
    expect(ping.status).toBe(200);
    const manifest = await fetch(`${url}/v2/${ref.replace(':', '/manifests/')}`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get('docker-content-digest')).toMatch(/^sha256:/);
    const tags = await fetch(`${url}/v2/${ref.split(':')[0]}/tags/list`);
    expect(((await tags.json()) as { tags: string[] }).tags).toContain('latest');

    child.kill('SIGTERM');
    await exited;
  }, 60_000);

  it('non-localhost bind auto-generates a token that every surface requires (V7)', async () => {
    const { url, child, exited, output } = await startServe(['--host', '0.0.0.0']);
    // the token banner line may land in a later stdout chunk than the URL
    let token: string | undefined;
    for (let i = 0; i < 100 && !token; i++) {
      token = /token: {4}([0-9a-f]{32}) \(generated/.exec(output())?.[1];
      if (!token) await new Promise((r) => setTimeout(r, 50));
    }
    expect(token).toBeTruthy();
    const denied = await fetch(`${url}/api/pods/refs`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${url}/api/pods/refs`, { headers: { authorization: `Bearer ${token}` } });
    expect(allowed.status).toBe(200);
    child.kill('SIGTERM');
    await exited;
  }, 60_000);

  it('ARTIPOD_UI_DIR serves a local UI build at / (S2 local-first)', async () => {
    const uiDir = await mkdtemp(join(tmpdir(), 'apod-ui-'));
    scratch.push(uiDir);
    await writeFile(join(uiDir, 'index.html'), '<html>LOCAL UI BUILD</html>');
    const { url, child, exited } = await startServe([], { env: { ARTIPOD_UI_DIR: uiDir } });
    expect(await (await fetch(url)).text()).toContain('LOCAL UI BUILD');
    // API still routes past the UI
    expect((await fetch(`${url}/api/pods/refs`)).status).toBe(200);
    child.kill('SIGTERM');
    await exited;
  }, 60_000);

  it('an artipod-ui:latest ref in the store materializes and serves (no network)', async () => {
    const uiDir = await mkdtemp(join(tmpdir(), 'apod-ui-src-'));
    const storeDir = await mkdtemp(join(tmpdir(), 'apod-ui-store-'));
    const uiHome = await mkdtemp(join(tmpdir(), 'apod-ui-home-'));
    scratch.push(uiDir, storeDir, uiHome);
    await writeFile(join(uiDir, 'index.html'), '<html>STORE UI</html>');
    // import the "built" UI into the store, exactly like a local release build would
    await new Promise<void>((res, rej) => {
      const imp = spawn('node', [CLI, 'import', uiDir, 'artipod-ui:latest', '--store', storeDir], {
        stdio: 'ignore',
      });
      imp.once('exit', (code) => (code === 0 ? res() : rej(new Error(`import exited ${code}`))));
    });
    // HOME points at a scratch dir so ~/.artipod/ui stays untouched
    const { url, child, exited, output } = await startServe([], { storeDir, env: { HOME: uiHome } });
    expect(await (await fetch(url)).text()).toContain('STORE UI');
    expect(output()).toContain('artipod-ui:latest (store)');
    child.kill('SIGTERM');
    await exited;
  }, 60_000);

  it('one artipod serves, another artipod shells in as the client (registry pull)', async () => {
    // server: publish a folder and serve it
    const scratchRoot = await mkdtemp(join(tmpdir(), 'apod-e2e-'));
    scratch.push(scratchRoot);
    const served = join(scratchRoot, 'field-notes');
    await mkdir(served);
    await writeFile(join(served, 'note.md'), 'served to the shell\n');
    const { url, child, exited } = await startServe(['--publish', served]);
    const hostPort = url.replace('http://', '');

    // client: a second artipod process resolves the ref straight off the
    // serve's /v2 registry surface (loopback = implicit HTTP) into a shell
    const clientStore = join(scratchRoot, 'client-store');
    const clientPods = join(scratchRoot, 'client-pods');
    const result = await new Promise<{ stdout: string; code: number | null }>((res) => {
      const proc = spawn(
        'node',
        [CLI, 'run', '--rm', `${hostPort}/field-notes:latest`, '--store', clientStore, '-c', 'cat note.md'],
        { env: { ...process.env, ARTIPOD_PODS: clientPods }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      proc.stdout.on('data', (c: Buffer) => (out += c.toString()));
      proc.stderr.on('data', (c: Buffer) => (out += c.toString()));
      proc.once('exit', (code) => res({ stdout: out, code }));
    });
    expect(result.stdout).toContain('served to the shell');
    expect(result.code).toBe(0);

    child.kill('SIGTERM');
    await exited;
  }, 60_000);
});
