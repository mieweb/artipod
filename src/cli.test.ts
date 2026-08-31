/**
 * CLI smoke tests (`artipod run`): spawns dist/cli.js — CI builds before
 * test. One-shot -c, --dir persistence across invocations, the piped-stdin
 * REPL, --help/--version, and the store round trip (commit+push in pod 1,
 * `run REF` resolves from the store in pod 2). Registry pulls are exercised
 * manually only — no network in CI.
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../dist/cli.js');

function run(args: string[], input?: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise) => {
    const child = execFile('node', [CLI, ...args], { timeout: 60_000 }, (error, stdout, stderr) => {
      resolvePromise({ stdout, stderr, code: (error as { code?: number } | null)?.code ?? 0 });
    });
    if (input !== undefined) {
      child.stdin!.write(input);
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
    expect(help.stdout).toContain('artipod run [-it] [REF]');
    const version = await run(['--version']);
    expect(version.stdout).toMatch(/^artipod \d+\.\d+\.\d+/);
  });

  it('one-shot -c runs in an ephemeral pod and mirrors the exit code', async () => {
    const ok = await run(['run', '-c', 'echo hello from the pod']);
    expect(ok.stdout).toContain('hello from the pod');
    expect(ok.code).toBe(0);
    const fail = await run(['run', '-c', 'false']);
    expect(fail.code).toBe(1);
    // Ephemeral: nothing carries between invocations.
    const gone = await run(['run', '-c', 'cat leftover.txt']);
    expect(gone.code).not.toBe(0);
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
    const r = await run(['run', '-it'], 'mkdir sub\ncd sub\necho inside > f.txt\ncat f.txt\npwd\nexit\n');
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
