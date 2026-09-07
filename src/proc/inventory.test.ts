/**
 * Inventory surfaces: `images`, `volumes`, pod-less `artipod`, and
 * the /proc/images + /proc/workspaces projection.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { createSandbox, type Sandbox } from '../sandbox/index.js';
import { makeConsoleArtipodCommand } from '../sandbox/inventory-command.js';
import { clearProcProviders, registerProcProvider } from './registry.js';
import { unmountProc } from './snapshot.js';
import { makeInventoryProvider, mountSlug, type InventoryProviders } from './inventory.js';
import { ProcessTable } from './processes.js';

const sampleLayers = [
  { digest: 'sha256:1111111111', size: 512, path: 'artipod.json', mtimeMs: Date.UTC(2026, 8, 6, 17, 0), actor: 'examples-builder', local: true },
  { digest: 'sha256:2222222222', size: 3 * 1024, path: 'main.js', mtimeMs: Date.UTC(2026, 8, 6, 18, 30), actor: 'browser:bfe8aff6', overlay: true, local: false },
];
const sampleManifest = JSON.stringify({ schemaVersion: 2, layers: sampleLayers.map((l) => ({ digest: l.digest, size: l.size, annotations: { 'org.artipod.path': l.path } })), annotations: { 'org.artipod.parents': '["sha256:b7e00e00aaaa"]' } });
const inventory: InventoryProviders = {
  images: () => [
    { ref: 'samples/lifecycle:_3', digest: 'sha256:e92582b61eb3f23e', encryption: 'plaintext', status: 'forked' },
    { ref: 'ghcr.io/mieweb/artipod-examples/case:latest', digest: 'sha256:c8209ca39cfe994f', encryption: 'plaintext', locked: true },
  ],
  imageDetail: (ref) => ref !== 'samples/lifecycle:_3' ? { manifestDigest: 'sha256:c8209ca39cfe994f', localPath: '/.artipod/oci/blobs/sha256/c8209ca3', localPresent: false, layers: [], parents: [], unavailable: 'locked — no key' } : {
    manifestDigest: 'sha256:e92582b61eb3f23e',
    localPath: '/.artipod/oci/blobs/sha256/e92582b6', localPresent: true, aliasPath: '/.artipod/oci/blobs/sha256/e92582b6.alias',
    remoteUrl: 'https://host.test/api/pods/blobs/sha256:e92582b6',
    parents: ['sha256:b7e00e00aaaa'], actor: 'browser:bfe8aff6',
    layers: sampleLayers, changed: [sampleLayers[1]], manifest: sampleManifest,
  },
  volumes: async () => [
    { name: 'ba772299', type: 'blank', mode: 'rw', encryption: 'plaintext' },
    { name: 'samples/lifecycle:_3', type: 'fork', mode: 'cow', encryption: 'encrypted', state: 'unpublished', mountpoint: '/open/samples_lifecycle__3' },
  ],
};

describe('inventory', () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    await unmountProc();
    clearProcProviders();
    try { umount('/'); } catch { /* first run */ }
    await configure({ mounts: { '/': InMemory } });
    await zfs.promises.mkdir('/repo');
    registerProcProvider(makeInventoryProvider(inventory));
    sandbox = createSandbox({ zfs, proc: true, cwd: '/repo', inventory, processes: new ProcessTable('catalog'),
      extraCommands: [makeConsoleArtipodCommand(inventory, new ProcessTable('catalog'))] });
  });

  it('images renders repository/tag columns and flags', async () => {
    const r = await sandbox.exec('images');
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^REPOSITORY\s+TAG\s+DIGEST\s+ENCRYPTION\s+LOCKED\s+STATUS$/);
    expect(lines[1]).toMatch(/^samples\/lifecycle\s+_3\s+e92582b6\s+plaintext\s+-\s+forked$/);
    expect(lines[2]).toMatch(/^ghcr\.io\/mieweb\/artipod-examples\/case\s+latest\s+c8209ca3\s+plaintext\s+yes\s+-$/);
    expect((await sandbox.exec('artipod images')).stdout).toBe(r.stdout);
  });

  it('images -v is summary-first: paths, hydration counts, what changed since the parent', async () => {
    const r = await sandbox.exec('images -v');
    expect(r.exitCode).toBe(0);
    const text = r.stdout;
    expect(text).toContain('samples/lifecycle:_3  @e92582b6  plaintext');
    expect(text).toContain('    local   /.artipod/oci/blobs/sha256/e92582b6');
    expect(text).toContain('    alias   /.artipod/oci/blobs/sha256/e92582b6.alias');
    expect(text).toContain('    remote  https://host.test/api/pods/blobs/sha256:e92582b6');
    expect(text).toContain('    parents b7e00e00');
    expect(text).toContain('    layers  2 file layers · 3.5 kB · 1 local ● 1 lazy ☁︎ · by browser:bfe8aff6');
    expect(text).toContain('    changed 1 file layer since b7e00e00:');
    expect(text).toMatch(/└─ 1 ☁︎ 22222222 {4}3\.0 kB {2}main\.js {2}2026-09-06 18:30 {2}browser:bfe8aff6 {2}\(overlay\)/);
    expect(text).not.toContain('11111111');
    expect(text).toContain('local   /.artipod/oci/blobs/sha256/c8209ca3   (not pulled');
    expect(text).toContain('layers  locked — no key');
    expect((await sandbox.exec('artipod images -v')).stdout).toBe(text);
    expect((await sandbox.exec('images -v nope:1')).stderr).toContain('no such image');
    expect((await sandbox.complete('images -v sam')).candidates).toEqual(['samples/lifecycle:_3']);
  });

  it('images -vv (or -v <ref>) shows the full stack with hydration marks', async () => {
    const full = (await sandbox.exec('images -vv samples/lifecycle:_3')).stdout;
    expect(full).toContain('    │   bottom → top; later layers win');
    expect(full).toMatch(/├─ 1 ● 11111111 {5}512 B {2}artipod\.json {2}2026-09-06 17:00 {2}examples-builder/);
    expect(full).toMatch(/└─ 2 ☁︎ 22222222 {4}3\.0 kB {2}main\.js {7}2026-09-06 18:30 {2}browser:bfe8aff6 {2}\(overlay\)/);
    expect(full).not.toContain('changed');
    expect(full).not.toContain('ghcr.io');
    expect((await sandbox.exec('images -v samples/lifecycle:_3')).stdout).toBe(full);
    const all = (await sandbox.exec('images -vv')).stdout;
    expect(all).toContain('ghcr.io');
    expect(all.split('\n').filter((l) => /^ {4}[├└]─/.test(l))).toHaveLength(2);
  });

  it('--json emits JSON Lines shaped like the exported types', async () => {
    const rows = (await sandbox.exec('images --json')).stdout.trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(rows).toEqual(await inventory.images!());
    const one = JSON.parse((await sandbox.exec('images -v samples/lifecycle:_3 --json')).stdout);
    expect(one.changed).toHaveLength(1);
    expect(one.layers[0].local).toBe(true);
    expect((await sandbox.exec('artipod images --json')).stdout).toBe((await sandbox.exec('images --json')).stdout);
    const vols = (await sandbox.exec('volumes --json')).stdout.trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(vols.map((v) => v.name)).toEqual(['ba772299', 'samples/lifecycle:_3']);
    expect((await sandbox.exec('volumes -m --json')).stdout.trimEnd().split('\n')).toHaveLength(1);
    const procs = (await sandbox.exec('ps --json')).stdout.trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(procs[0]).toMatchObject({ pid: 1, kind: 'init' });
    expect((await sandbox.exec('images -v nope:1 --json')).stderr).toContain('no such image');
  });

  it('images -v explains an empty, missing, or unreadable parent diff', async () => {
    const { renderImageDetail } = await import('../sandbox/inventory-command.js');
    const base = { manifestDigest: 'sha256:aa', localPath: '/x', localPresent: true, layers: sampleLayers };
    const row = { ref: 'r:_1', digest: 'sha256:aa' };
    expect(renderImageDetail(row, { ...base, parents: ['sha256:bb'], changed: [] })).toContain('changed nothing since bb   (same layer set');
    expect(renderImageDetail(row, { ...base, parents: ['sha256:bb'] })).toContain('changed (parent bb is not readable here');
    expect(renderImageDetail(row, { ...base, parents: [] })).toContain('changed (no parent — first head of this tag');
  });

  it('projects the raw OCI manifest for jq', async () => {
    const r = await sandbox.exec(`jq -r '.layers[].annotations["org.artipod.path"]' /proc/images/samples_lifecycle__3/manifest.json`);
    expect(r.stdout).toBe('artipod.json\nmain.js\n');
    expect((await sandbox.exec('cat /proc/images/samples_lifecycle__3/status')).stdout).toContain('Hydrated:\t1/2');
    expect((await sandbox.exec('ls /proc/images/ghcr.io_mieweb_artipod-examples_case_latest/')).stdout).toBe('status\n');
  });

  it('volumes lists every workspace; -m only the mounted ones; mount/lsblk stay the ZenFS commands', async () => {
    const all = (await sandbox.exec('volumes')).stdout.trimEnd().split('\n');
    expect(all[0]).toMatch(/^NAME\s+TYPE\s+MODE\s+ENCRYPTION\s+STATE\s+MOUNTPOINT$/);
    expect(all[1]).toMatch(/^ba772299\s+blank\s+rw\s+plaintext\s+-$/);
    expect(all[2]).toMatch(/^samples\/lifecycle:_3\s+fork\s+cow\s+encrypted\s+unpublished\s+\/open\/samples_lifecycle__3$/);
    const mounted = (await sandbox.exec('volumes -m')).stdout.trimEnd().split('\n');
    expect(mounted).toHaveLength(2);
    expect(mounted[1]).toContain('/open/samples_lifecycle__3');
    expect((await sandbox.exec('artipod volumes -m')).stdout).toBe(`${mounted.join('\n')}\n`);
    // The storage commands are untouched: `mount` is the ZenFS mtab, `lsblk` the origin quota.
    expect((await sandbox.exec('mount')).stdout).toMatch(/ on \/ type /);
    expect((await sandbox.exec('mount --help')).stdout).toContain('artipod image mount <ref>');
    expect((await sandbox.exec('lsblk')).stdout).toMatch(/^NAME\s+SIZE\s+TYPE\s+MOUNTPOINTS/);
  });

  it('pod-less artipod explains itself and refuses pod verbs', async () => {
    expect((await sandbox.exec('artipod')).stdout).toContain('This console has no pod open');
    const r = await sandbox.exec('artipod snapshot ls');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("'snapshot' needs an open pod");
    expect((await sandbox.exec('artipod ps')).stdout).toMatch(/^PID\s+KIND\s+STATE\s+NAME\n\s*1\s+init\s+running\s+catalog/);
  });

  it('projects /proc/images and /proc/workspaces', async () => {
    const r = await sandbox.exec(`cat /proc/images/${mountSlug('ghcr.io/mieweb/artipod-examples/case:latest')}/status; cat /proc/workspaces/samples_lifecycle__3/status`);
    expect(r.stdout).toContain('Locked:\tyes');
    expect(r.stdout).toContain('Mounted:\tyes');
    expect(r.stdout).toContain('Mountpoint:\t/open/samples_lifecycle__3');
    expect((await sandbox.exec('cat /proc/workspaces/ba772299/status')).stdout).toContain('Mounted:\tno');
  });

  it('tab-completes custom commands and their sub-verbs', async () => {
    expect((await sandbox.complete('art')).candidates).toEqual(['artipod']);
    expect((await sandbox.complete('vol')).candidates).toEqual(['volumes']);
    expect(await sandbox.complete('artipod ')).toEqual({ candidates: ['help', 'images', 'ps', 'volumes'], replaceStart: 8 });
    expect((await sandbox.complete('artipod im')).candidates).toEqual(['images']);
    expect((await sandbox.complete('artipod volumes ')).candidates).toEqual(['--json', '-m']);
    expect((await sandbox.complete('artipod images ')).candidates).toEqual(['--json', '-v', '-vv']);
    expect((await sandbox.complete('kill -')).candidates).toEqual(['-CONT', '-KILL', '-STOP', '-TERM']);
    expect((await sandbox.complete('echo hi; kill -S')).candidates).toEqual(['-STOP']);
    expect((await sandbox.complete('images ')).candidates).toEqual(['--json', '-v', '-vv']);
  });
});
