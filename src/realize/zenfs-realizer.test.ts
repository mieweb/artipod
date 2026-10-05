/**
 * ZenFS realizer + pod tests: manifest-driven mounts, hostDir parity with
 * the host view (the Phase 3 contract), cow isolation, /proc/pod projection,
 * tools + agent tools over the realized mount table.
 */
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod, symlink, readlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { umount, mounts as zenMounts } from '@zenfs/core';
import { createZenFsPod, realizeZenFs } from './zenfs.js';
import type { ZenFsPod } from './zenfs.js';
import type { PodManifest } from '../manifest.js';

let hostDir: string;
const pods: ZenFsPod[] = [];

function unmountAll() {
  for (const path of [...zenMounts.keys()]) {
    if (path === '/') continue;
    try {
      umount(path);
    } catch {
      // fine
    }
  }
  try {
    umount('/');
  } catch {
    // fine
  }
}

beforeEach(async () => {
  unmountAll();
  hostDir = await mkdtemp(join(tmpdir(), 'artipod-realize-'));
  await writeFile(join(hostDir, 'hello.txt'), 'from the host\n');
  await mkdir(join(hostDir, 'sub'));
  await writeFile(join(hostDir, 'sub', 'nested.txt'), 'nested\n');
});

afterEach(async () => {
  for (const pod of pods.splice(0)) pod.dispose();
  await rm(hostDir, { recursive: true, force: true });
});

// hostDir is only known inside beforeEach; build manifests lazily.
const hostManifest = (): PodManifest => ({
  mounts: [
    { name: 'work', path: '/', source: { kind: 'backend', backend: 'memory' }, mode: 'rw' },
    { name: 'src', path: '/context/src', source: { kind: 'hostDir', dir: hostDir }, mode: 'ro' },
  ],
});

describe('realizeZenFs + createZenFsPod', () => {
  it('same manifest, same file view: sandbox find matches the host walk (contract)', async () => {
    const pod = await createZenFsPod(hostManifest());
    pods.push(pod);
    const sandbox = pod.createSandbox();

    const r = await sandbox.exec('find /context/src -type f | sort');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      '/context/src/hello.txt',
      '/context/src/sub/nested.txt',
    ]);
    const cat = await sandbox.exec('cat /context/src/hello.txt');
    expect(cat.stdout).toBe('from the host\n');
    // and the memory mount is writable + isolated from the host
    const w = await sandbox.exec('echo scratch > /notes.txt && cat /notes.txt');
    expect(w.stdout).toBe('scratch\n');
  });

  it('cow mounts stack a writable upper: sandbox writes never reach the host', async () => {
    const pod = await createZenFsPod({
      mounts: [
        { name: 'work', path: '/', source: { kind: 'backend', backend: 'memory' }, mode: 'rw' },
        { name: 'src', path: '/context/src', source: { kind: 'hostDir', dir: hostDir }, mode: 'cow' },
      ],
    });
    pods.push(pod);
    const sandbox = pod.createSandbox();

    const before = await sandbox.exec('cat /context/src/hello.txt');
    expect(before.stdout).toBe('from the host\n');

    const w = await sandbox.exec('echo overwritten > /context/src/hello.txt && cat /context/src/hello.txt');
    expect(w.exitCode).toBe(0);
    expect(w.stdout).toBe('overwritten\n');

    // the host file is untouched — writes stayed in the CoW upper
    expect(await readFile(join(hostDir, 'hello.txt'), 'utf8')).toBe('from the host\n');
  });

  it('projects the manifest into /proc/pod/manifest.json for shell + model', async () => {
    const pod = await createZenFsPod(hostManifest());
    pods.push(pod);
    const sandbox = pod.createSandbox();
    const r = await sandbox.exec('cat /proc/pod/manifest.json');
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.mounts.map((m: { path: string }) => m.path)).toEqual(['/', '/context/src']);
  });

  it('pod file tools + agent tools resolve over the manifest mount table', async () => {
    const pod = await createZenFsPod(hostManifest());
    pods.push(pod);
    const fileTools = pod.createFileTools();
    const tools = new Map<string, (typeof fileTools)[number]>(fileTools.map((t) => [t.name, t]));

    const read = (await tools.get('read_file')!.execute({ filePath: '/context/src/hello.txt' } as never)) as {
      success: boolean;
      content?: string;
    };
    expect(read.success).toBe(true);
    expect(read.content).toContain('from the host');

    // readonly mount: create_file must refuse
    const denied = (await tools.get('create_file')!.execute({
      filePath: '/context/src/nope.txt',
      content: 'x',
    } as never)) as { success: boolean; error?: string };
    expect(denied.success).toBe(false);
    expect(denied.error).toMatch(/read-only/);

    // agent surface over the same table shares the store with the shell
    const sandbox = pod.createSandbox();
    const agentTools = pod.createAgentTools(sandbox);
    const created = await agentTools.get('create_file')!.execute({ filePath: '/made-by-agent.txt', content: 'hi' });
    expect(created.success).toBe(true);
    expect((await sandbox.exec('cat /made-by-agent.txt')).stdout).toBe('hi');
  });

  it('adopt mode wraps an existing fs without remounting', async () => {
    const first = await createZenFsPod(hostManifest());
    pods.push(first);
    await first.zfs.promises.writeFile('/existing.txt', 'kept');

    const adopted = await createZenFsPod(
      { mounts: [{ name: 'root', path: '/', source: { kind: 'backend', backend: 'memory' }, mode: 'rw' }] },
      { adopt: first.zfs },
    );
    pods.push(adopted);
    const sandbox = adopted.createSandbox();
    expect((await sandbox.exec('cat /existing.txt')).stdout).toBe('kept');
  });

  it('volume sources and root images fail fast until Phase 4', async () => {
    await expect(
      realizeZenFs({
        mounts: [{ name: 'v', path: '/v', source: { kind: 'volume', ref: 'org/x:1' }, mode: 'ro' }],
      }),
    ).rejects.toThrow(/Phase 4/);
    await expect(
      realizeZenFs({ root: { image: 'alpine' }, mounts: hostManifest().mounts }),
    ).rejects.toThrow(/Phase 4/);
  });
});


describe('single native hostDir snapshot checkout', () => {
  it('CLI checkout preserves native symlinks and modes and refuses to overwrite an occupied destination', async () => {
    await writeFile(join(hostDir, 'source'), 'binary\0content');
    await chmod(join(hostDir, 'source'), 0o751);
    await symlink('source', join(hostDir, 'link'));
    await symlink('missing', join(hostDir, 'dangling'));
    await chmod(join(hostDir, 'sub'), 0o555);
    const pod = await createZenFsPod({ mounts: [{ name: 'root', path: '/', mode: 'rw', source: { kind: 'hostDir', dir: hostDir } }] }, { proc: false });
    pods.push(pod);
    const snapshot = (await pod.snapshots.create())!;
    const sandbox = pod.createSandbox();
    try {
      const checked = await sandbox.exec(`artipod snapshot checkout ${snapshot.id}`);
      expect(checked.exitCode).toBe(0);
      const branch = join(hostDir, 'branches', snapshot.id);
      expect(await readFile(join(branch, 'source'), 'utf8')).toBe('binary\0content');
      expect((await lstat(join(branch, 'source'))).mode & 0o777).toBe(0o751);
      expect((await lstat(join(branch, 'link'))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(branch, 'link'))).toBe('source');
      expect(await readlink(join(branch, 'dangling'))).toBe('missing');
      expect((await lstat(join(branch, 'sub'))).mode & 0o777).toBe(0o555);
      await writeFile(join(branch, 'source'), 'precious branch work');
      const refused = await sandbox.exec(`artipod snapshot checkout ${snapshot.id}`);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain('empty');
      expect(await readFile(join(branch, 'source'), 'utf8')).toBe('precious branch work');
      await chmod(join(branch, 'sub'), 0o755);
    } finally {
      sandbox.dispose();
      await chmod(join(hostDir, 'sub'), 0o755);
    }
  });
});
