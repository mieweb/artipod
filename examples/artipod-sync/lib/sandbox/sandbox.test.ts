/**
 * Sandbox session tests: bash semantics over ZenFS plus the host-side session
 * reconstruction (cwd via result.env.PWD, env replay, BASH_ALIAS_ pinning).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { createSandbox, type Sandbox } from './index';

let sandbox: Sandbox;

beforeEach(async () => {
  try {
    umount('/');
  } catch {
    // first run
  }
  await configure({ mounts: { '/': InMemory } });
  await zfs.promises.mkdir('/repo');
  sandbox = createSandbox({ zfs });
});

describe('sandbox bash semantics over ZenFS', () => {
  it('runs pipelines, globs, vars and loops', async () => {
    await zfs.promises.writeFile('/repo/a.md', 'one\ntwo\n');
    await zfs.promises.writeFile('/repo/b.md', 'three\n');
    await zfs.promises.writeFile('/repo/c.txt', 'x\n');

    expect((await sandbox.exec('ls | wc -l')).stdout.trim()).toBe('3');
    expect((await sandbox.exec('echo *.md')).stdout.trim()).toBe('a.md b.md');

    const loop = await sandbox.exec('for f in *.md; do wc -l < "$f"; done');
    expect(loop.stdout.replace(/\s+/g, ' ').trim()).toBe('2 1');

    const redirect = await sandbox.exec('echo hello > out.txt && cat out.txt');
    expect(redirect.stdout.trim()).toBe('hello');
    expect(await zfs.promises.readFile('/repo/out.txt', 'utf8')).toBe('hello\n');
  });

  it('reports sensible errors for missing files', async () => {
    const r = await sandbox.exec('cat missing.txt');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/missing\.txt/);
  });
});

describe('session state reconstruction across exec calls', () => {
  it('persists cwd via result.env.PWD', async () => {
    await zfs.promises.mkdir('/repo/sub');
    await sandbox.exec('cd sub');
    expect(sandbox.getCwd()).toBe('/repo/sub');
    expect((await sandbox.exec('pwd')).stdout.trim()).toBe('/repo/sub');
    await sandbox.exec('cd ..');
    expect(sandbox.getCwd()).toBe('/repo');
  });

  it('persists variables and exports via env replay', async () => {
    await sandbox.exec('X=5');
    expect((await sandbox.exec('echo $X')).stdout.trim()).toBe('5');

    await sandbox.exec('export Y=exported');
    expect((await sandbox.exec('echo $Y')).stdout.trim()).toBe('exported');
  });

  it('keeps unset variables unset (replaceEnv replay)', async () => {
    await sandbox.exec('Z=9');
    await sandbox.exec('unset Z');
    expect((await sandbox.exec('echo "[$Z]"')).stdout.trim()).toBe('[]');
  });

  it('pins the BASH_ALIAS_<name> env carry for aliases', async () => {
    await sandbox.exec("alias ll='echo aliased'");
    // implementation detail, not a documented contract — this test is the canary
    expect(sandbox.getEnv()).toHaveProperty('BASH_ALIAS_ll');
    expect((await sandbox.exec('ll')).stdout.trim()).toBe('aliased');
  });

  it('does not absorb state from transient execs (completion helpers)', async () => {
    await zfs.promises.mkdir('/repo/tmp2');
    await sandbox.exec('cd tmp2', { transient: true });
    expect(sandbox.getCwd()).toBe('/repo');
  });

  it('supports cooperative cancellation via AbortSignal', async () => {
    const controller = new AbortController();
    const pending = sandbox.exec('while true; do :; done', { signal: controller.signal });
    controller.abort();
    const r = await pending.catch((e: Error) => ({ aborted: true, message: e.message }));
    // Either shape is fine as long as the loop terminated promptly.
    expect(r).toBeTruthy();
  }, 10_000);
});
