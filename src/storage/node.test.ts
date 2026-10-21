import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { generateBlobKey, isEncryptedBlob } from '../oci/cipher.js';
import { openBrowserVault } from '../sandbox/browser-vault.js';
import { createNativeStorageAdapters } from './node.js';

const directories: string[] = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), 'artipod-native-storage-'));
  directories.push(directory);
  return directory;
}
async function rawFiles(directory: string, prefix = ''): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, await rawFiles(join(directory, entry.name), `${name}/`));
    else files[name] = new Uint8Array(await readFile(join(directory, entry.name)));
  }
  return files;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('native encrypted storage backing', () => {
  it('persists only ciphertext from the first block write and reopens exact names and contents', async () => {
    const directory = await temporary();
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const adapters = await createNativeStorageAdapters(directory, { onWrite: (path, bytes) => { writes.push({ path, bytes }); } });
    expect(await adapters.readControl()).toBeNull();
    const key = await generateBlobKey();
    let vault = await openBrowserVault({ adapters, getKey: () => key });
    const path = '/PRIVATE-native-name.csv';
    const body = new TextEncoder().encode('PRIVATE-native-payload');
    await vault.filesystem.createFile(path, { uid: 0, gid: 0, mode: 0o100640 });
    await vault.filesystem.write(path, body, 0);
    await vault.filesystem.touch(path, { size: body.length });
    await vault.flush();
    const generation = vault.generation;
    expect(vault.backend).toBe('native');
    const blockWrites = writes.filter(write => write.path.includes(`${generation}/`));
    expect(blockWrites.length).toBeGreaterThan(0);
    for (const { path: rawPath, bytes } of writes) {
      expect(rawPath).not.toContain('PRIVATE');
      expect(new TextDecoder().decode(bytes)).not.toContain('PRIVATE');
    }
    expect(blockWrites.every(write => isEncryptedBlob(write.bytes))).toBe(true);
    const blocks = await readdir(join(directory, 'generations', generation));
    expect(blocks.length).toBeGreaterThan(0);
    for (const name of blocks) {
      expect(name).toMatch(/^\d+$/);
      expect(isEncryptedBlob(new Uint8Array(await readFile(join(directory, 'generations', generation, name))))).toBe(true);
    }
    await vault.close();
    vault = await openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => key });
    expect(vault.generation).toBe(generation);
    expect(await vault.filesystem.readdir('/')).toContain(path.slice(1));
    const actual = new Uint8Array(body.length);
    await vault.filesystem.read(path, actual, 0, actual.length);
    expect(actual).toEqual(body);
    await vault.close();
  });

  it('refuses wrong keys and corrupt records without replacing the saved generation', async () => {
    const directory = await temporary();
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => key });
    const generation = vault.generation;
    await vault.close();
    const control = await readFile(join(directory, 'control.json'));
    const rootPath = join(directory, 'generations', generation, '0');
    const root = await readFile(rootPath);
    const wrong = await generateBlobKey();
    await expect(openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => wrong })).rejects.toThrow();
    expect(await readFile(join(directory, 'control.json'))).toEqual(control);
    expect(await readFile(rootPath)).toEqual(root);
    const corrupt = root.slice();
    corrupt[corrupt.length - 1] ^= 1;
    await writeFile(rootPath, corrupt);
    await expect(openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => key })).rejects.toThrow();
    expect(await readFile(join(directory, 'control.json'))).toEqual(control);
    expect(await readFile(rootPath)).toEqual(corrupt);
    expect(await readdir(join(directory, 'generations'))).toEqual([generation]);
  });

  it('keeps exclusive ownership through reset and permits a fresh generation afterward', async () => {
    const directory = await temporary();
    const key = await generateBlobKey();
    const adapters = await createNativeStorageAdapters(directory);
    const owner = await openBrowserVault({ adapters, getKey: () => key });
    const generation = owner.generation;
    await expect(openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => key })).rejects.toThrow(/owns.*lock/);
    const erase = adapters.erase;
    let complete!: () => void;
    const terminal = new Promise<void>(resolve => { complete = resolve; });
    let started!: () => void;
    const deleting = new Promise<void>(resolve => { started = resolve; });
    adapters.erase = async () => { started(); await terminal; await erase(); };
    const reset = owner.reset();
    await deleting;
    await expect(openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => key })).rejects.toThrow(/owns.*lock/);
    complete();
    expect(await reset).toEqual({ warnings: [] });
    expect(await readdir(directory)).toEqual([]);
    const fresh = await openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => key });
    expect(fresh.generation).not.toBe(generation);
    await fresh.close();
  });

  it.each(['null', 'false', '0', '""', '[]', '{}'])('preserves saved storage when the control file contains %s', async control => {
    const directory = await temporary();
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => key });
    const path = '/retained-private.csv';
    const body = new TextEncoder().encode('saved rows must remain reachable');
    await vault.filesystem.createFile(path, { uid: 0, gid: 0, mode: 0o100600 });
    await vault.filesystem.write(path, body, 0);
    await vault.filesystem.touch(path, { size: body.length });
    const generation = vault.generation;
    await vault.close();
    const originalControl = await readFile(join(directory, 'control.json'));
    await writeFile(join(directory, 'control.json'), control);
    const original = await rawFiles(directory);
    const adapters = await createNativeStorageAdapters(directory);
    // Close an incorrectly successful open so the regression itself cannot
    // leave a writer behind when it runs against the broken implementation.
    await expect(openBrowserVault({ adapters, getKey: () => key }).then(async unexpected => {
      await unexpected.close();
    })).rejects.toThrow(/control file|bootstrap is corrupt/);
    expect(await rawFiles(directory)).toEqual(original);
    expect(await readdir(join(directory, 'generations'))).toEqual([generation]);
    await writeFile(join(directory, 'control.json'), originalControl);
    const reopened = await openBrowserVault({ adapters, getKey: () => key });
    expect(reopened.generation).toBe(generation);
    const actual = new Uint8Array(body.length);
    await reopened.filesystem.read(path, actual, 0, actual.length);
    expect(actual).toEqual(body);
    await reopened.close();
  });

  it('preserves orphaned encrypted generations instead of initializing an empty replacement', async () => {
    const directory = await temporary();
    const key = await generateBlobKey();
    const vault = await openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => key });
    const generation = vault.generation;
    await vault.close();
    const rootPath = join(directory, 'generations', generation, '0');
    const root = await readFile(rootPath);
    await unlink(join(directory, 'control.json'));
    await expect(openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => key })).rejects.toThrow(/without their bootstrap/);
    expect(await readFile(rootPath)).toEqual(root);
    expect(await readdir(join(directory, 'generations'))).toEqual([generation]);
    expect(await readdir(directory)).toEqual(['generations']);
  });

  it('reports failed block writes, preserves the persisted tree, and releases the failed owner', async () => {
    const directory = await temporary();
    const key = await generateBlobKey();
    let fail = false;
    const adapters = await createNativeStorageAdapters(directory, { onWrite: path => {
      if (fail && path.includes('generations')) throw new Error('Injected native write failure');
    } });
    const vault = await openBrowserVault({ adapters, getKey: () => key });
    const generation = vault.generation;
    const parent = join(directory, 'generations', generation);
    const original = new Map(await Promise.all((await readdir(parent)).map(async name => [name, await readFile(join(parent, name))] as const)));
    fail = true;
    await vault.filesystem.createFile('/rejected.csv', { uid: 0, gid: 0, mode: 0o100600 }).catch(() => {});
    await expect(vault.flush()).rejects.toThrow(/Injected native write failure/);
    await expect(vault.close()).rejects.toThrow(/Injected native write failure/);
    expect(await readdir(parent)).toEqual([...original.keys()]);
    for (const [name, bytes] of original) expect(await readFile(join(parent, name))).toEqual(bytes);
    const reopened = await openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => key });
    expect(reopened.generation).toBe(generation);
    expect(await reopened.filesystem.exists('/rejected.csv')).toBe(false);
    await reopened.close();
  });

  it('surfaces erase failure while preserving the generation and releasing writer ownership', async () => {
    const directory = await temporary();
    const key = await generateBlobKey();
    const adapters = await createNativeStorageAdapters(directory);
    const vault = await openBrowserVault({ adapters, getKey: () => key });
    const generation = vault.generation;
    adapters.erase = async () => { throw new Error('Injected native erase failure'); };
    await expect(vault.reset()).rejects.toThrow(/Injected native erase failure/);
    const reopened = await openBrowserVault({ adapters: await createNativeStorageAdapters(directory), getKey: () => key });
    expect(reopened.generation).toBe(generation);
    await reopened.close();
  });

  it('reports a dead owner lock without racing an automatic lock replacement', async () => {
    const directory = await temporary();
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid!;
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
    const bytes = JSON.stringify({ formatVersion: 1, pid, token: 'a'.repeat(32) });
    await writeFile(join(directory, '.writer.lock'), bytes);
    const adapters = await createNativeStorageAdapters(directory);
    await expect(adapters.acquireWriter()).rejects.toThrow(/stale.*dead process/);
    expect(await readFile(join(directory, '.writer.lock'), 'utf8')).toBe(bytes);
    expect(await readdir(directory)).toEqual(['.writer.lock']);
  });

  it('refuses invalid generation paths before writing outside its namespace', async () => {
    const directory = await temporary();
    const adapters = await createNativeStorageAdapters(directory);
    const release = await adapters.acquireWriter();
    try { await expect(adapters.generation('../outside', 'create')).rejects.toThrow(/Invalid.*generation/); }
    finally { release(); }
    expect(await readdir(directory)).toEqual([]);
  });
});
