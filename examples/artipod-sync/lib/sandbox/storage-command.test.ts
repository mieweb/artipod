/**
 * `mount` / `df` over ZenFS. Node has no navigator.storage, so these tests
 * cover the mount enumeration, the table layout and the --scan walk; the
 * origin quota row only appears in a browser.
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

describe('mount', () => {
  it('lists the ZenFS mount points with their backend', async () => {
    const r = await sandbox.exec('mount');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('tmpfs on / type memory (rw)');
  });

  it('refuses to actually mount anything', async () => {
    const r = await sandbox.exec('mount /dev/sda /mnt');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/not supported/);
  });
});

describe('df', () => {
  it('prints a df-shaped table with a row per device', async () => {
    const r = await sandbox.exec('df');
    expect(r.exitCode).toBe(0);
    const [header, first] = r.stdout.trim().split('\n');
    expect(header.split(/\s+/)).toEqual(['Filesystem', '1K-blocks', 'Used', 'Avail', 'Use%', 'Mounted', 'on']);
    expect(first).toMatch(/^tmpfs\s/);
    expect(first).toMatch(/\/$/);
  });

  it('reports exact apparent bytes with --scan', async () => {
    await zfs.promises.writeFile('/repo/big.txt', 'x'.repeat(4096));
    const r = await sandbox.exec('df --scan');
    expect(r.stdout.split('\n')[1].split(/\s+/)[2]).toBe('4');
  });

  it('renders human sizes with -h', async () => {
    await zfs.promises.writeFile('/repo/big.txt', 'x'.repeat(3 * 1024 * 1024));
    const r = await sandbox.exec('df -h --scan');
    expect(r.stdout).toMatch(/\s3M\s/);
  });

  it('ignores compatibility flags in a cluster, as real df does', async () => {
    const plain = await sandbox.exec('df -h');
    const noisy = await sandbox.exec('df -vhP');
    expect(noisy.exitCode).toBe(0);
    expect(noisy.stdout).toBe(plain.stdout);
  });

  it('adds a Type column with -T', async () => {
    const r = await sandbox.exec('df -T');
    expect(r.stdout.split('\n')[0].split(/\s+/).slice(0, 2)).toEqual(['Filesystem', 'Type']);
    expect(r.stdout.split('\n')[1]).toMatch(/^tmpfs\s+memory\s/);
  });

  it('accepts a path and reports only its file system', async () => {
    const r = await sandbox.exec('df --scan /repo');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(2);
  });

  it('rejects unknown flags', async () => {
    const r = await sandbox.exec('df -z');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/unrecognized option '-z'/);
  });

  it('keeps -h for human sizes and --help for help', async () => {
    const help = await sandbox.exec('df --help');
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toMatch(/^usage: df /);
    expect((await sandbox.exec('df -h')).stdout).toMatch(/^Filesystem/);
  });
});

describe('block-device views', () => {
  it('findmnt lists targets and sources', async () => {
    const r = await sandbox.exec('findmnt');
    expect(r.stdout.split('\n')[0].split(/\s+/)).toEqual(['TARGET', 'SOURCE', 'FSTYPE', 'OPTIONS']);
    expect(r.stdout.split('\n')[1]).toMatch(/^\/\s+tmpfs\s+memory\s+rw$/);
  });

  it('lsblk shows the origin disk with the backends as partitions', async () => {
    const r = await sandbox.exec('lsblk');
    const lines = r.stdout.trim().split('\n');
    expect(lines[0].split(/\s+/)).toEqual(['NAME', 'SIZE', 'TYPE', 'MOUNTPOINTS']);
    expect(lines[1]).toMatch(/^origin\s/);
    expect(lines[2]).toMatch(/^└─mem0\s+-\s+part\s+\/$/);
  });

  it('lsblk -f swaps in the filesystem columns', async () => {
    const r = await sandbox.exec('lsblk -f');
    expect(r.stdout.split('\n')[0].split(/\s+/)).toEqual([
      'NAME',
      'FSTYPE',
      'LABEL',
      'UUID',
      'FSUSE%',
      'MOUNTPOINTS',
    ]);
    // ZenFS gives every mount a real UUID.
    expect(r.stdout).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('fdisk -l describes the quota as the disk', async () => {
    const r = await sandbox.exec('fdisk -l');
    expect(r.stdout).toMatch(/^Disk \/dev\/origin: /);
    expect(r.stdout).toMatch(/\/dev\/mem0\s+memory/);
    expect((await sandbox.exec('fdisk')).exitCode).toBe(1);
  });

  it('diskutil list prints the partition map', async () => {
    const r = await sandbox.exec('diskutil list');
    expect(r.stdout).toMatch(/^\/dev\/origin \(browser, shared quota\):/);
    expect(r.stdout).toMatch(/1:\s+memory\s+tmpfs/);
    expect((await sandbox.exec('diskutil info')).exitCode).toBe(1);
  });

  it('every view answers --help', async () => {
    for (const name of ['mount', 'findmnt', 'lsblk', 'fdisk', 'diskutil']) {
      const long = await sandbox.exec(`${name} --help`);
      const short = await sandbox.exec(`${name} -h`);
      expect(long.exitCode, name).toBe(0);
      expect(long.stdout, name).toMatch(new RegExp(`^usage: ${name}\\b`));
      expect(short.stdout, name).toBe(long.stdout);
    }
  });
});
