/**
 * CLI smoke tests (`artipod run`): spawns dist/cli.js — CI builds before
 * test. One-shot -c, kept-by-default pods (`artipod pods` + resume by id
 * prefix), --rm/--disk ephemerals, --dir persistence across invocations, the
 * piped-stdin REPL, --help/--version, and the store round trip (commit+push
 * in pod 1, `run REF` resolves from the store in pod 2). Registry pulls are
 * exercised manually only — no network in CI.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../dist/cli.js');
// Keep default-persisted pods out of the developer's real ~/.artipod/pods.
const SCRATCH_PODS = await mkdtemp(join(tmpdir(), 'apod-pods-scratch-'));
afterAll(() => rm(SCRATCH_PODS, { recursive: true, force: true }));

function run(
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      'node',
      [CLI, ...args],
      { timeout: 60_000, env: { ...process.env, ARTIPOD_PODS: SCRATCH_PODS, ...opts.env } },
      (error, stdout, stderr) => {
        resolvePromise({ stdout, stderr, code: (error as { code?: number } | null)?.code ?? 0 });
      },
    );
    if (opts.input !== undefined) {
      child.stdin!.write(opts.input);
      child.stdin!.end();
    }
  });
}

describe('artipod CLI', () => {
  it('is built (CI runs build before test)', async () => {
    await access(CLI);
  });

  it('--help and --version', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('artipod run [-it] [REF|POD]');
    expect(help.stdout).toContain('artipod pods');
    const version = await run(['--version']);
    expect(version.stdout).toMatch(/^artipod \d+\.\d+\.\d+/);
  });

  it('one-shot -c with --rm runs in an ephemeral pod and mirrors the exit code', async () => {
    const ok = await run(['run', '--rm', '-c', 'echo hello from the pod']);
    expect(ok.stdout).toContain('hello from the pod');
    expect(ok.code).toBe(0);
    const fail = await run(['run', '--rm', '-c', 'false']);
    expect(fail.code).toBe(1);
    // Ephemeral: nothing carries between invocations.
    const gone = await run(['run', '--rm', '-c', 'cat leftover.txt']);
    expect(gone.code).not.toBe(0);
  });

  it('keeps pods by default: `artipod pods` lists them and a pod-id prefix resumes', async () => {
    const podsRoot = await mkdtemp(join(tmpdir(), 'apod-pods-'));
    try {
      const first = await run(['run', '-c', 'echo keep > k.txt'], { env: { ARTIPOD_PODS: podsRoot } });
      expect(first.code).toBe(0);
      const dirs = await readdir(podsRoot);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]).toMatch(/^[0-9a-f]{16}$/);
      const list = await run(['pods'], { env: { ARTIPOD_PODS: podsRoot } });
      expect(list.stdout).toContain('POD ID');
      expect(list.stdout).toContain(dirs[0]);
      const resumed = await run(['run', dirs[0].slice(0, 8), '-c', 'cat k.txt'], { env: { ARTIPOD_PODS: podsRoot } });
      expect(resumed.stdout).toContain('keep');
      // Resume reopened the pod instead of minting a second one.
      expect(await readdir(podsRoot)).toHaveLength(1);
    } finally {
      await rm(podsRoot, { recursive: true, force: true });
    }
  });

  it('--rm --disk backs the ephemeral pod with a temp dir and still keeps nothing', async () => {
    const podsRoot = await mkdtemp(join(tmpdir(), 'apod-pods-'));
    try {
      const r = await run(['run', '--rm', '--disk', '-c', 'echo big > f.txt && cat f.txt'], {
        env: { ARTIPOD_PODS: podsRoot },
      });
      expect(r.stdout).toContain('big');
      expect(r.code).toBe(0);
      expect(await readdir(podsRoot)).toHaveLength(0);
      // --disk without --rm is a usage error (kept pods are disk-backed already).
      const misuse = await run(['run', '--disk', '-c', 'true'], { env: { ARTIPOD_PODS: podsRoot } });
      expect(misuse.code).toBe(2);
    } finally {
      await rm(podsRoot, { recursive: true, force: true });
    }
  });

  it('`artipod pods` with no pods explains itself', async () => {
    const r = await run(['pods'], { env: { ARTIPOD_PODS: join(tmpdir(), `apod-none-${Date.now()}`) } });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no pods yet');
  });

  it('create-on-write: an untouched fresh pod is not kept, a written one is', async () => {
    const podsRoot = await mkdtemp(join(tmpdir(), 'apod-pods-'));
    try {
      const readOnly = await run(['run', '-c', 'pwd'], { env: { ARTIPOD_PODS: podsRoot } });
      expect(readOnly.code).toBe(0);
      expect(await readdir(podsRoot)).toHaveLength(0);
      const written = await run(['run', '-c', 'echo data > f.txt'], { env: { ARTIPOD_PODS: podsRoot } });
      expect(written.code).toBe(0);
      expect(await readdir(podsRoot)).toHaveLength(1);
    } finally {
      await rm(podsRoot, { recursive: true, force: true });
    }
  });

  it('rm deletes a kept pod by prefix; prune -f wipes the root (but never without -f when piped)', async () => {
    const podsRoot = await mkdtemp(join(tmpdir(), 'apod-pods-'));
    try {
      await run(['run', '-c', 'echo a > a.txt'], { env: { ARTIPOD_PODS: podsRoot } });
      await run(['run', '-c', 'echo b > b.txt'], { env: { ARTIPOD_PODS: podsRoot } });
      const dirs = await readdir(podsRoot);
      expect(dirs).toHaveLength(2);
      const removed = await run(['rm', dirs[0].slice(0, 8)], { env: { ARTIPOD_PODS: podsRoot } });
      expect(removed.code).toBe(0);
      expect(removed.stdout).toContain(`removed ${dirs[0]}`);
      expect(await readdir(podsRoot)).toHaveLength(1);
      const missing = await run(['rm', 'no-such-pod'], { env: { ARTIPOD_PODS: podsRoot } });
      expect(missing.code).toBe(1);
      // Non-TTY prune without -f refuses while a pod still exists.
      const refused = await run(['prune'], { env: { ARTIPOD_PODS: podsRoot } });
      expect(refused.code).toBe(1);
      expect(await readdir(podsRoot)).toHaveLength(1);
      const pruned = await run(['prune', '-f'], { env: { ARTIPOD_PODS: podsRoot } });
      expect(pruned.code).toBe(0);
      expect(pruned.stdout).toContain('total reclaimed');
      expect(await readdir(podsRoot)).toHaveLength(0);
    } finally {
      await rm(podsRoot, { recursive: true, force: true });
    }
  });

  it('--dir persists the pod (files + snapshots) across invocations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'apod-cli-'));
    const store = await mkdtemp(join(tmpdir(), 'apod-store-'));
    try {
      const first = await run(['run', '--dir', dir, '--store', store, '-c', 'echo keep > k.txt && artipod snapshot create s1']);
      expect(first.stdout).toContain('snapshot');
      const second = await run(['run', '--dir', dir, '--store', store, '-c', 'artipod snapshot ls && cat k.txt']);
      expect(second.stdout).toContain('s1');
      expect(second.stdout).toContain('keep');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(store, { recursive: true, force: true });
    }
  });

  it('the REPL reads piped stdin, carries cwd, and exits cleanly', async () => {
    const r = await run(['run', '-it'], { input: 'mkdir sub\ncd sub\necho inside > f.txt\ncat f.txt\npwd\nexit\n' });
    expect(r.stdout).toContain('inside');
    expect(r.stdout).toContain('/sub');
    expect(r.code).toBe(0);
  });

  it('run REF resolves a pushed volume ref from the local store and materializes at /', async () => {
    const store = await mkdtemp(join(tmpdir(), 'apod-store-'));
    try {
      const push = await run([
        'run',
        '--store',
        store,
        '-c',
        'echo "field data" > notes.md && artipod commit --tag field/notes:1 && artipod push field/notes:1',
      ]);
      expect(push.stdout).toContain('pushed field/notes:1');
      const cloned = await run(['run', 'field/notes:1', '--store', store, '-c', 'cat notes.md']);
      expect(cloned.stdout).toContain('materialized field/notes:1 at /');
      expect(cloned.stdout).toContain('field data');
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it('refuses non-interactive run with no command', async () => {
    const r = await run(['run']);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('did you mean -it');
  });
});
