/**
 * git command tests over a fixture repo built with isomorphic-git APIs
 * (no network) — exercised through the sandbox's `git` custom command.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import git from 'isomorphic-git';
import { createGitOps } from '../git';
import { createSandbox, type Sandbox } from './index';

const AUTHOR = { name: 'Test', email: 'test@example.com' };

let sandbox: Sandbox;

async function initRepoFixture() {
  const dir = '/repo';
  await zfs.promises.mkdir(dir);
  await git.init({ fs: zfs, dir, defaultBranch: 'main' });
  await zfs.promises.writeFile(`${dir}/readme.md`, 'v1\n');
  await git.add({ fs: zfs, dir, filepath: 'readme.md' });
  await git.commit({ fs: zfs, dir, message: 'initial', author: AUTHOR });
}

beforeEach(async () => {
  try {
    umount('/');
  } catch {
    // first run
  }
  await configure({ mounts: { '/': InMemory } });
  await initRepoFixture();
  sandbox = createSandbox({ zfs });
});

describe('git custom command (Phase 3 surface)', () => {
  it('status shows branch and short-status codes', async () => {
    const clean = await sandbox.exec('git status');
    expect(clean.stdout).toMatch(/On branch main/);
    expect(clean.stdout).toMatch(/working tree clean/);

    await zfs.promises.writeFile('/repo/readme.md', 'v2 with more bytes\n');
    await zfs.promises.writeFile('/repo/new.txt', 'n\n');
    const dirty = await sandbox.exec('git status');
    expect(dirty.stdout).toMatch(/ M readme\.md/);
    expect(dirty.stdout).toMatch(/\?\? new\.txt/);
  });

  it('add ., commit -m, log --oneline complete the loop', async () => {
    await zfs.promises.writeFile('/repo/readme.md', 'v2 with more bytes\n');
    await zfs.promises.writeFile('/repo/new.txt', 'n\n');

    expect((await sandbox.exec('git add .')).exitCode).toBe(0);
    const staged = await sandbox.exec('git status');
    expect(staged.stdout).toMatch(/M {2}readme\.md/);
    expect(staged.stdout).toMatch(/A {2}new\.txt/);

    const commit = await sandbox.exec('git commit -m "second change"');
    expect(commit.exitCode).toBe(0);
    expect(commit.stdout).toMatch(/second change/);

    const log = await sandbox.exec('git log --oneline');
    expect(log.stdout.trim().split('\n')).toHaveLength(2);
    expect(log.stdout).toMatch(/second change/);
    expect(log.stdout).toMatch(/initial/);
  });

  it('commit refuses when nothing is staged', async () => {
    const r = await sandbox.exec('git commit -m "empty"');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/nothing to commit/);
  });

  it('reset unstages and rm removes', async () => {
    await zfs.promises.writeFile('/repo/readme.md', 'v2 with more bytes\n');
    await sandbox.exec('git add readme.md');
    await sandbox.exec('git reset readme.md');
    const st = await sandbox.exec('git status');
    expect(st.stdout).toMatch(/ M readme\.md/);

    await sandbox.exec('git rm readme.md');
    expect(await zfs.promises.exists('/repo/readme.md')).toBe(false);
    const st2 = await sandbox.exec('git status');
    expect(st2.stdout).toMatch(/D {2}readme\.md|D. readme\.md/);
  });

  it('diff variants: file, all, --staged', async () => {
    await zfs.promises.writeFile('/repo/readme.md', 'v2 with more bytes\n');

    const one = await sandbox.exec('git diff readme.md');
    expect(one.stdout).toMatch(/-v1/);
    expect(one.stdout).toMatch(/\+v2 with more bytes/);

    const all = await sandbox.exec('git diff');
    expect(all.stdout).toMatch(/readme\.md/);

    const emptyStaged = await sandbox.exec('git diff --staged');
    expect(emptyStaged.stdout.trim()).toBe('');

    await sandbox.exec('git add readme.md');
    const staged = await sandbox.exec('git diff --staged');
    expect(staged.stdout).toMatch(/\+v2 with more bytes/);
  });

  it('branch and checkout -b work', async () => {
    const main = await sandbox.exec('git branch');
    expect(main.stdout).toMatch(/\* main/);

    const co = await sandbox.exec('git checkout -b feature');
    expect(co.exitCode).toBe(0);
    const branches = await sandbox.exec('git branch');
    expect(branches.stdout).toMatch(/\* feature/);
    expect(branches.stdout).toMatch(/ {2}main/);

    await sandbox.exec('git checkout main');
    expect((await sandbox.exec('git branch')).stdout).toMatch(/\* main/);
  });

  it('config stores author identity', async () => {
    await sandbox.exec('git config user.name Alice');
    await sandbox.exec('git config user.email alice@example.com');
    expect((await sandbox.exec('git config user.name')).stdout.trim()).toBe('Alice');
    expect((await sandbox.exec('git config user.email')).stdout.trim()).toBe('alice@example.com');

    await zfs.promises.writeFile('/repo/x.txt', 'x\n');
    await sandbox.exec('git add x.txt');
    await sandbox.exec('git commit -m "by alice"');
    const log = await sandbox.exec('git log -n 1');
    expect(log.stdout).toMatch(/Alice <alice@example\.com>/);
  });

  it('rejects non-https clone URLs', async () => {
    const r = await sandbox.exec('git clone http://example.com/a.git');
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/only https/);

    const r2 = await sandbox.exec("git clone 'javascript:alert(1)'");
    expect(r2.exitCode).not.toBe(0);
  });
});

describe('createGitOps direct API', () => {
  it('diffAll covers deletions and additions', async () => {
    const ops = createGitOps(() => zfs);
    await zfs.promises.rm('/repo/readme.md');
    await zfs.promises.writeFile('/repo/added.txt', 'add\n');
    const diff = await ops.diffAll('/repo');
    expect(diff).toMatch(/-v1/);
    expect(diff).toMatch(/\+add/);
  });
});
