/**
 * Docker realizer contract (plan Phase 3): the same manifest that drives the
 * ZenFS realizer binds hostDirs at their manifest-declared paths in a
 * hardened container — same file view, both execution backends. Virtual
 * sources fail fast (collision #4).
 */
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArtiPod } from '../artipod.js';
import type { PodManifest } from '../manifest.js';

let hostSrc: string;
let hostWork: string;
let pod: ArtiPod;

const dockerfilePath = join(process.cwd(), 'container', 'Dockerfile');
const seccompProfilePath = join(process.cwd(), 'container', 'seccomp-profiles', 'sandbox.json');

const manifest = (): PodManifest => ({
  mounts: [
    { name: 'src', path: '/data/src', source: { kind: 'hostDir', dir: hostSrc }, mode: 'ro' },
    { name: 'work', path: '/work', source: { kind: 'hostDir', dir: hostWork }, mode: 'rw' },
  ],
});

describe('ArtiPod.fromManifest + docker realizer', () => {
  beforeAll(async () => {
    hostSrc = await mkdtemp(join(tmpdir(), 'artipod-mansrc-'));
    hostWork = await mkdtemp(join(tmpdir(), 'artipod-manwork-'));
    // mkdtemp dirs are 0700 — unreadable for the container's non-root user on
    // real Linux binds (macOS Docker Desktop masks this). Match the suite's
    // chmod-777 convention.
    await chmod(hostSrc, 0o777);
    await chmod(hostWork, 0o777);
    await writeFile(join(hostSrc, 'hello.txt'), 'from the host\n');
    await mkdir(join(hostSrc, 'sub'));
    await chmod(join(hostSrc, 'sub'), 0o777);
    await writeFile(join(hostSrc, 'sub', 'nested.txt'), 'nested\n');

    pod = ArtiPod.fromManifest(manifest());
    await pod.initialize();
    await pod.startContainer(dockerfilePath, { seccompProfilePath });
  }, 180000);

  afterAll(async () => {
    try {
      await pod?.stopContainer();
    } catch {
      // container may not have started
    }
    await rm(hostSrc, { recursive: true, force: true });
    await rm(hostWork, { recursive: true, force: true });
  }, 60000);

  it('binds mounts at manifest paths — same file view as the ZenFS realizer', async () => {
    const r = await pod.executeCommand('find /data/src -type f | sort');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['/data/src/hello.txt', '/data/src/sub/nested.txt']);
    const cat = await pod.executeCommand('cat /data/src/hello.txt');
    expect(cat.stdout).toBe('from the host\n');
  }, 120000);

  it('enforces ro at the container boundary; rw mounts write through to the host', async () => {
    const denied = await pod.executeCommand('sh -c "echo x > /data/src/nope.txt"');
    expect(denied.exitCode).not.toBe(0);

    const ok = await pod.executeCommand('sh -c "echo through > /work/out.txt"');
    expect(ok.exitCode).toBe(0);
    expect(await readFile(join(hostWork, 'out.txt'), 'utf8')).toBe('through\n');
  }, 120000);

  it('getManifest echoes the manifest; buildPrompt walks the manifest mounts', async () => {
    expect(pod.getManifest()?.mounts.map((m) => m.path)).toEqual(['/data/src', '/work']);
    const prompt = await pod.buildPrompt();
    expect(prompt).toContain('hello.txt');
  }, 120000);
});

describe('fromManifest fail-fast (no docker needed)', () => {
  it('rejects virtual sources with an actionable error', () => {
    expect(() =>
      ArtiPod.fromManifest({
        mounts: [
          { name: 'v', path: '/v', source: { kind: 'backend', backend: 'memory' }, mode: 'rw' },
        ],
      }),
    ).toThrow(/virtual source/);
  });
});
