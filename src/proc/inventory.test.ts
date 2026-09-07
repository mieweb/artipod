/**
 * Inventory surfaces: `images`, `lsblk`, `mount`, pod-less `artipod`, and
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

const inventory: InventoryProviders = {
  images: () => [
    { ref: 'samples/lifecycle:_3', digest: 'sha256:e92582b61eb3f23e', encryption: 'plaintext', status: 'forked' },
    { ref: 'ghcr.io/mieweb/artipod-examples/case:latest', digest: 'sha256:c8209ca39cfe994f', encryption: 'plaintext', locked: true },
  ],
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

  it('lsblk lists every workspace; mount and -m only the mounted ones', async () => {
    const all = (await sandbox.exec('lsblk')).stdout.trimEnd().split('\n');
    expect(all[0]).toMatch(/^NAME\s+TYPE\s+MODE\s+ENCRYPTION\s+STATE\s+MOUNTPOINT$/);
    expect(all[1]).toMatch(/^ba772299\s+blank\s+rw\s+plaintext\s+-$/);
    expect(all[2]).toMatch(/^samples\/lifecycle:_3\s+fork\s+cow\s+encrypted\s+unpublished\s+\/open\/samples_lifecycle__3$/);
    const mounted = (await sandbox.exec('mount')).stdout.trimEnd().split('\n');
    expect(mounted).toHaveLength(2);
    expect(mounted[1]).toContain('/open/samples_lifecycle__3');
    expect((await sandbox.exec('lsblk -m')).stdout).toBe(`${mounted.join('\n')}\n`);
    expect((await sandbox.exec('artipod lsblk -m')).stdout).toBe(`${mounted.join('\n')}\n`);
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
    expect((await sandbox.complete('lsb')).candidates).toEqual(['lsblk']);
    expect(await sandbox.complete('artipod ')).toEqual({ candidates: ['help', 'images', 'lsblk', 'ps'], replaceStart: 8 });
    expect((await sandbox.complete('artipod im')).candidates).toEqual(['images']);
    expect((await sandbox.complete('artipod lsblk ')).candidates).toEqual(['-m']);
    expect((await sandbox.complete('artipod images ')).candidates).toEqual([]);
    expect((await sandbox.complete('kill -')).candidates).toEqual(['-CONT', '-KILL', '-STOP', '-TERM']);
    expect((await sandbox.complete('echo hi; kill -S')).candidates).toEqual(['-STOP']);
    expect((await sandbox.complete('images ')).candidates).toEqual([]);
  });
});
