/**
 * Inventory surfaces: `images`, `lsblk`, `mount`, pod-less `artipod`, and
 * the /proc/images + /proc/workspaces projection.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { createSandbox, type Sandbox } from '../sandbox/index.js';
import { makeConsoleArtipodCommand, renderImagesVerbose } from '../sandbox/inventory-command.js';
import { clearProcProviders, registerProcProvider } from './registry.js';
import { unmountProc } from './snapshot.js';
import { makeInventoryProvider, mountSlug, type InventoryProviders } from './inventory.js';
import { ProcessTable } from './processes.js';

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
    layers: [
      { digest: 'sha256:1111111111', size: 512, path: 'artipod.json', mtimeMs: Date.UTC(2026, 8, 6, 17, 0), actor: 'examples-builder' },
      { digest: 'sha256:2222222222', size: 3 * 1024, path: 'main.js', mtimeMs: Date.UTC(2026, 8, 6, 18, 30), actor: 'browser:bfe8aff6', overlay: true },
    ],
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

  it('images -v shows where the bytes live and the layer tree', async () => {
    const r = await sandbox.exec('images -v');
    expect(r.exitCode).toBe(0);
    const text = r.stdout;
    expect(text).toContain('samples/lifecycle:_3  @e92582b6  plaintext');
    expect(text).toContain('    local   /.artipod/oci/blobs/sha256/e92582b6');
    expect(text).toContain('    alias   /.artipod/oci/blobs/sha256/e92582b6.alias');
    expect(text).toContain('    remote  https://host.test/api/pods/blobs/sha256:e92582b6');
    expect(text).toContain('    parents b7e00e00');
    expect(text).toContain('    layers  2 · 3.5 kB · by browser:bfe8aff6');
    expect(text).toMatch(/├─ 1 {2}11111111 {5}512 B {2}artipod\.json {2}2026-09-06 17:00 {2}examples-builder/);
    expect(text).toMatch(/└─ 2 {2}22222222 {4}3\.0 kB {2}main\.js {7}2026-09-06 18:30 {2}browser:bfe8aff6 {2}\(overlay\)/);
    expect(text).toContain('local   /.artipod/oci/blobs/sha256/c8209ca3   (not pulled');
    expect(text).toContain('layers  locked — no key');
    expect((await sandbox.exec('artipod images -v')).stdout).toBe(text);
    expect((await sandbox.exec('cat /proc/images/samples_lifecycle__3/status')).stdout).toContain('Alias:\t/.artipod/oci/blobs/sha256/e92582b6.alias');
    const one = await sandbox.exec('images -v samples/lifecycle:_3');
    expect(one.stdout.split('\n').filter((l) => l.startsWith('    ├─') || l.startsWith('    └─'))).toHaveLength(2);
    expect(one.stdout).not.toContain('ghcr.io');
    expect((await sandbox.exec('images -v nope:1')).stderr).toContain('no such image');
    expect((await sandbox.complete('images -v sam')).candidates).toEqual(['samples/lifecycle:_3']);
  });

  it('images -v caps long layer stacks in the listing, not in the single-image view', async () => {
    const many: InventoryProviders = {
      images: () => [{ ref: 'big:_1', digest: 'sha256:abcdef0123456789' }],
      imageDetail: () => ({ manifestDigest: 'sha256:abcdef0123456789', localPath: '/x', localPresent: true, parents: [],
        layers: Array.from({ length: 30 }, (_, i) => ({ digest: `sha256:${String(i).padStart(8, '0')}`, size: 100, path: `/f${i}` })) }),
    };
    const listing = await renderImagesVerbose(many);
    expect(listing).toContain('… 22 older layers (images -v big:_1 shows all)');
    expect(listing.split('\n').filter((l) => /^ {4}[├└]─/.test(l))).toHaveLength(8);
    expect(listing).toMatch(/├─ 23 {2}00000022/);
    expect(listing).toMatch(/└─ 30 {2}00000029/);
    const full = await renderImagesVerbose(many, 'big:_1');
    expect(full.split('\n').filter((l) => /^ {4}[├└]─/.test(l))).toHaveLength(30);
    expect(full).not.toContain('older layers');
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
    expect((await sandbox.complete('artipod images ')).candidates).toEqual(['-v']);
    expect((await sandbox.complete('kill -')).candidates).toEqual(['-CONT', '-KILL', '-STOP', '-TERM']);
    expect((await sandbox.complete('echo hi; kill -S')).candidates).toEqual(['-STOP']);
    expect((await sandbox.complete('images ')).candidates).toEqual(['-v']);
  });
});
