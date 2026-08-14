/**
 * The proc framework: registry, snapshot rebuild, rw write-back — plus the
 * shell surface (`lsmod`/`modprobe`, `mount`/`umount`) that exposes them.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { createSandbox, type Sandbox } from '../sandbox/index';
import {
  clearProcProviders,
  listProviders,
  registerProcProvider,
  setProviderEnabled,
} from './registry';
import { procEntries, refreshProc, unmountProc, writeTree } from './snapshot';
import { reconcileProc } from './reconcile';

let sandbox: Sandbox;

beforeEach(async () => {
  await unmountProc();
  clearProcProviders();
  try {
    umount('/');
  } catch {
    // first run
  }
  await configure({ mounts: { '/': InMemory } });
  await zfs.promises.mkdir('/repo');
  sandbox = createSandbox({ zfs, proc: true, cwd: '/repo' });
});

const provider = (name: string, tree: Record<string, string>) => ({
  name,
  description: `${name} test provider`,
  version: '1',
  mode: 'ro' as const,
  read: async () => tree,
});

describe('registry', () => {
  it('unregisters through the returned function', () => {
    const off = registerProcProvider(provider('a', {}));
    expect(listProviders()).toHaveLength(2); // 'a' plus the built-in storage
    off();
    expect(listProviders().map((m) => m.provider.name)).toEqual(['storage']);
  });

  it('refuses a duplicate name and an rw provider with no write()', () => {
    registerProcProvider(provider('a', {}));
    expect(() => registerProcProvider(provider('a', {}))).toThrow(/already registered/);
    expect(() =>
      registerProcProvider({ name: 'b', mode: 'rw', read: async () => ({}) }),
    ).toThrow(/no write/);
  });
});

describe('snapshot', () => {
  it('writes each provider tree under /proc/<name>', async () => {
    registerProcProvider(provider('zustand', { 'form.json': '{"a":1}' }));
    await refreshProc(zfs);
    expect(await zfs.promises.readFile('/proc/zustand/form.json', 'utf8')).toBe('{"a":1}');
  });

  it("writes a root-less provider straight into /proc", async () => {
    registerProcProvider({ ...provider('route', {}), root: '', read: async () => ({ 'route.json': '"#/"' }) });
    await refreshProc(zfs);
    expect(await zfs.promises.readFile('/proc/route.json', 'utf8')).toBe('"#/"');
  });

  it('rebuilds from scratch, so stale files do not survive', async () => {
    let tree: Record<string, string> = { 'a.json': '1', 'b.json': '2' };
    registerProcProvider({ ...provider('x', {}), read: async () => tree });
    await refreshProc(zfs);
    tree = { 'a.json': '3' };
    await refreshProc(zfs);
    expect(await zfs.promises.readdir('/proc/x')).toEqual(['a.json']);
    expect(await zfs.promises.readFile('/proc/x/a.json', 'utf8')).toBe('3');
  });

  it('reports a throwing provider without losing the others', async () => {
    registerProcProvider({
      ...provider('bad', {}),
      read: async () => {
        throw new Error('nope');
      },
    });
    registerProcProvider(provider('good', { 'ok.json': '1' }));
    const errors = await refreshProc(zfs);
    expect(errors).toEqual(['proc: bad: nope']);
    expect(await zfs.promises.exists('/proc/good/ok.json')).toBe(true);
  });

  it('mkdir -p writeTree also works on the persistent tree', async () => {
    await writeTree(zfs, '/artipods/demo', { 'forms/case.yaml': 'id: case\n' });
    expect(await zfs.promises.readFile('/artipods/demo/forms/case.yaml', 'utf8')).toBe('id: case\n');
  });
});

describe('reconcile', () => {
  it('hands a changed rw file back to its provider, and ignores untouched ones', async () => {
    const writes: [string, string][] = [];
    let stored = 'value: 1\n';
    registerProcProvider({
      name: 'cases',
      mode: 'rw',
      read: async () => ({ 'responses.yaml': stored }),
      write: async (rel, content) => {
        writes.push([rel, new TextDecoder().decode(content)]);
        stored = new TextDecoder().decode(content);
      },
    });

    await refreshProc(zfs);
    expect(await reconcileProc(zfs)).toEqual([]);
    expect(writes).toHaveLength(0);

    await zfs.promises.writeFile('/proc/cases/responses.yaml', 'value: 2\n');
    await reconcileProc(zfs);
    expect(writes).toEqual([['responses.yaml', 'value: 2\n']]);
  });

  it('surfaces a provider write error and reverts on the next refresh', async () => {
    registerProcProvider({
      name: 'cases',
      mode: 'rw',
      read: async () => ({ 'responses.yaml': 'value: 1\n' }),
      write: async () => {
        throw new Error('malformed');
      },
    });
    await refreshProc(zfs);
    await zfs.promises.writeFile('/proc/cases/responses.yaml', 'garbage');
    expect(await reconcileProc(zfs)).toEqual(['proc: cases: responses.yaml: malformed']);
    await refreshProc(zfs);
    expect(await zfs.promises.readFile('/proc/cases/responses.yaml', 'utf8')).toBe('value: 1\n');
  });

  it('runs around each command, so the shell sees fresh state and edits land', async () => {
    let stored = 'value: 1\n';
    registerProcProvider({
      name: 'cases',
      mode: 'rw',
      read: async () => ({ 'responses.yaml': stored }),
      write: async (_rel, content) => {
        stored = new TextDecoder().decode(content);
      },
    });
    const write = await sandbox.exec("echo 'value: 2' > /proc/cases/responses.yaml");
    expect(write.exitCode).toBe(0);
    expect(stored).toBe('value: 2\n');
    expect((await sandbox.exec('cat /proc/cases/responses.yaml')).stdout).toBe('value: 2\n');
  });
});

describe('module commands', () => {
  beforeEach(() => {
    registerProcProvider(provider('zustand', { 'form.json': '{}' }));
  });

  it('lsmod lists the providers with their file counts', async () => {
    const r = await sandbox.exec('lsmod');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^Module\s+Mode\s+Files\s+State$/m);
    expect(r.stdout).toMatch(/^zustand\s+ro\s+1\s+Live$/m);
  });

  it('modinfo prints the provider metadata', async () => {
    const r = await sandbox.exec('modinfo zustand');
    expect(r.stdout).toContain('description: zustand test provider');
    expect(r.stdout).toContain('file:        /proc/zustand/form.json');
    expect((await sandbox.exec('modinfo nope')).exitCode).toBe(1);
  });

  it('modprobe -r hides the provider from /proc, and modprobe brings it back', async () => {
    expect((await sandbox.exec('ls /proc')).stdout).toContain('zustand');
    await sandbox.exec('modprobe -r zustand');
    expect(setProviderEnabled('zustand', false)).toBe(true);
    expect((await sandbox.exec('ls /proc')).stdout).not.toContain('zustand');
    await sandbox.exec('modprobe zustand');
    expect((await sandbox.exec('ls /proc')).stdout).toContain('zustand');
  });
});

describe('mount / umount', () => {
  it('mounts an in-memory filesystem anywhere and shows it in the storage views', async () => {
    expect((await sandbox.exec('mount -t memory /scratch')).exitCode).toBe(0);
    await sandbox.exec('echo hi > /scratch/note.txt');
    expect((await sandbox.exec('cat /scratch/note.txt')).stdout).toBe('hi\n');

    for (const view of ['mount', 'df', 'findmnt', 'lsblk']) {
      expect((await sandbox.exec(view)).stdout, view).toContain('/scratch');
    }
  });

  it('rejects an unknown type and a mount point already in use', async () => {
    expect((await sandbox.exec('mount -t nfs /scratch')).stderr).toMatch(/unknown filesystem type/);
    await sandbox.exec('mount -t memory /scratch');
    expect((await sandbox.exec('mount -t memory /scratch')).stderr).toMatch(/already in use/);
  });

  it('unmounts a memory device but refuses / and /proc', async () => {
    await sandbox.exec('mount -t memory /scratch');
    expect((await sandbox.exec('umount /scratch')).exitCode).toBe(0);
    expect((await sandbox.exec('umount /scratch')).stderr).toMatch(/not mounted/);
    expect((await sandbox.exec('umount /')).stderr).toMatch(/cannot unmount/);
    expect((await sandbox.exec('umount /proc')).stderr).toMatch(/cannot unmount/);
  });
});

describe('the snapshot is only refreshed for real commands', () => {
  it('leaves the entry table alone for transient execs', async () => {
    registerProcProvider(provider('zustand', { 'form.json': '{}' }));
    await sandbox.exec('true');
    const before = [...procEntries().keys()];
    await sandbox.complete('ls /pr');
    expect([...procEntries().keys()]).toEqual(before);
  });
});
