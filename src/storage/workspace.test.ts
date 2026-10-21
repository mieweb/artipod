import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, InMemoryStore, fs, mount, mounts, resolveMountConfig, umount } from '@zenfs/core';
import { createStorageSession, encryptedStoreMount, openWorkspaceUpper, workspaceUpperPaths, upperDirName, type BrowserVaultAdapters, type BrowserVaultControl, type StorageSession } from './index.js';
import { generateBlobKey, isEncryptedBlob } from '../oci/cipher.js';

const REF = 'synthetic-private-workspace:1';
const NAME = 'synthetic-private-filename.csv';
const PAYLOAD = 'synthetic-private-payload';
const { directory: destination, committed } = workspaceUpperPaths(REF);
const legacyTree = `/.artipod/uppers/${encodeURIComponent(REF)}`;

const sessions: StorageSession[] = [];
afterEach(async () => {
  for (const path of [...mounts.keys()].filter(path => path !== '/').sort((a, b) => b.length - a.length)) umount(path);
  await Promise.all(sessions.splice(0).map(session => session.close()));
});

beforeEach(async () => {
  for (const path of [...mounts.keys()].sort((a, b) => b.length - a.length)) umount(path);
  await configure({ mounts: { '/': InMemory } });
});

async function fixture() {
  const key = await generateBlobKey();
  const backing = new InMemoryStore();
  let control: BrowserVaultControl | null = null;
  let owned = false;
  const adapters: BrowserVaultAdapters = {
    backend: 'indexeddb',
    async acquireWriter() {
      if (owned) throw new Error('Another writer owns the fixture');
      owned = true;
      return () => { owned = false; };
    },
    async readControl() { return control; },
    async writeControl(value) { control = structuredClone(value); },
    async generation() { return { kind: 'store', store: backing }; },
    async removeGeneration() { backing.clear(); },
    async legacySources() { return []; },
    async erase() { backing.clear(); control = null; },
  };
  const root = createStorageSession({ adapters, keys: {
    getKey: () => key, requireKey: () => key, storagePolicy: 'encrypted',
    async suspendForReset() { return () => {}; },
  } });
  sessions.push(root);
  const storage = await root.open();
  return {
    key, backing, root,
    options: { storage, ref: REF, getKey: () => key },
  };
}

async function seedTree() {
  await fs.promises.mkdir(`${legacyTree}/nested`, { recursive: true });
  await fs.promises.chmod(`${legacyTree}/nested`, 0o750);
  await fs.promises.writeFile(`${legacyTree}/nested/${NAME}`, PAYLOAD);
  await fs.promises.chmod(`${legacyTree}/nested/${NAME}`, 0o640);
  await fs.promises.symlink(`nested/${NAME}`, `${legacyTree}/link.csv`);
}

describe('workspace upper migration inside the encrypted root', () => {
  it.each(['', '.', '..', 'invalid\0ref', null, undefined])('rejects invalid ref %j before touching private metadata or sibling uppers', async ref => {
    const { options, backing, root } = await fixture();
    await seedTree();
    await fs.promises.mkdir('/.artipod/uppers/sibling', { recursive: true });
    await fs.promises.writeFile('/.artipod/uppers/sibling/saved', PAYLOAD);
    await fs.promises.writeFile('/.artipod/private-metadata.json', NAME);
    await root.flush();
    const before = [...backing].map(([id, bytes]) => [id, bytes.slice()]);
    const invalid = ref as unknown as string;
    expect(() => workspaceUpperPaths(invalid)).toThrow('Invalid workspace reference');
    await expect(openWorkspaceUpper({ ...options, ref: invalid })).rejects.toThrow('Invalid workspace reference');
    await expect(root.openWorkspaceUpper(invalid)).rejects.toThrow('Invalid workspace reference');
    expect([...backing]).toEqual(before);
    expect(await fs.promises.readFile('/.artipod/private-metadata.json', 'utf8')).toBe(NAME);
    expect(await fs.promises.readFile('/.artipod/uppers/sibling/saved', 'utf8')).toBe(PAYLOAD);
    expect(await fs.promises.readFile(`${legacyTree}/nested/${NAME}`, 'utf8')).toBe(PAYLOAD);
  });

  it('opens an untouched broker upper containing only plaintext bootstrap records', async () => {
    const { options, key } = await fixture();
    const configured = await resolveMountConfig({ backend: InMemory });
    const blocks = (configured as unknown as { store: InMemoryStore }).store;
    const old = await encryptedStoreMount({ backing: { kind: 'config', config: configured }, getKey: () => key });
    await old.flush();
    expect(await old.readdir('/')).toEqual([]);
    expect(blocks.has(0)).toBe(true);
    expect([...blocks.values()].every(bytes => !isEncryptedBlob(bytes))).toBe(true);
    const legacyBlocks = `/.artipod/uppers/${await upperDirName(REF)}`;
    await fs.promises.mkdir(legacyBlocks, { recursive: true });
    for (const [id, bytes] of blocks) await fs.promises.writeFile(`${legacyBlocks}/${id}`, bytes);
    const upper = await openWorkspaceUpper(options);
    expect(await upper.readdir('/')).toEqual([]);
    expect(await fs.promises.exists(committed)).toBe(true);
    expect(await fs.promises.exists(legacyBlocks)).toBe(false);
    const bytes = new TextEncoder().encode(PAYLOAD);
    await upper.createFile(`/${NAME}`, { uid: 0, gid: 0, mode: 0o100600 });
    await upper.write(`/${NAME}`, bytes, 0);
    await upper.touch(`/${NAME}`, { size: bytes.length });
    await options.storage.flush();
    const reopened = await openWorkspaceUpper(options);
    const saved = new Uint8Array((await reopened.stat(`/${NAME}`)).size);
    await reopened.read(`/${NAME}`, saved, 0, saved.length);
    expect(new TextDecoder().decode(saved)).toBe(PAYLOAD);
  });

  it.each(['missing', 'empty'])('preserves a damaged legacy upper with a %s root', async kind => {
    const { options } = await fixture();
    const legacyBlocks = `/.artipod/uppers/${await upperDirName(REF)}`;
    await fs.promises.mkdir(legacyBlocks, { recursive: true });
    await fs.promises.writeFile(`${legacyBlocks}/123`, 'recoverable encrypted file block');
    if (kind === 'empty') await fs.promises.writeFile(`${legacyBlocks}/0`, new Uint8Array());
    await expect(openWorkspaceUpper(options)).rejects.toThrow(`root block is ${kind}`);
    expect(await fs.promises.readFile(`${legacyBlocks}/123`, 'utf8')).toBe('recoverable encrypted file block');
    expect(await fs.promises.exists(committed)).toBe(false);
    expect(await fs.promises.exists(destination)).toBe(false);
    expect(await fs.promises.exists(`${legacyBlocks}/0`)).toBe(kind === 'empty');
  });

  it.each([false, true])('keeps refs ending in .ready independent (reverse order: %s)', async reverse => {
    const { options } = await fixture();
    const refs = reverse ? [`${REF}.ready`, REF] : [REF, `${REF}.ready`];
    for (const ref of refs) {
      const upper = await openWorkspaceUpper({ ...options, ref });
      await upper.createFile('/saved.txt', { uid: 0, gid: 0, mode: 0o100600 });
      const bytes = new TextEncoder().encode(ref);
      await upper.write('/saved.txt', bytes, 0);
      await upper.touch('/saved.txt', { size: bytes.length });
      await options.storage.flush();
    }
    for (const ref of refs) {
      await openWorkspaceUpper({ ...options, ref });
      expect(await fs.promises.readFile(`${workspaceUpperPaths(ref).directory}/saved.txt`, 'utf8')).toBe(ref);
    }
  });

  it.each(['directory', 'invalid contents'])('refuses a commit record with %s without deleting source', async kind => {
    const { options } = await fixture();
    await seedTree();
    await fs.promises.mkdir(destination, { recursive: true });
    if (kind === 'directory') await fs.promises.mkdir(committed);
    else await fs.promises.writeFile(committed, 'corrupt');
    await expect(openWorkspaceUpper(options)).rejects.toThrow('commit record is invalid');
    expect(await fs.promises.readFile(`${legacyTree}/nested/${NAME}`, 'utf8')).toBe(PAYLOAD);
  });

  it('preserves files, names, links and directory/file modes before removing legacy tree', async () => {
    const { options, backing, root } = await fixture();
    await seedTree();
    const upper = await openWorkspaceUpper(options);
    await fs.promises.mkdir('/view');
    mount('/view', upper);
    expect(await fs.promises.readFile(`/view/nested/${NAME}`, 'utf8')).toBe(PAYLOAD);
    expect((await fs.promises.stat('/view/nested')).mode & 0o777).toBe(0o750);
    expect((await fs.promises.stat(`/view/nested/${NAME}`)).mode & 0o777).toBe(0o640);
    expect((await fs.promises.lstat('/view/link.csv')).isSymbolicLink()).toBe(true);
    expect(await fs.promises.readlink('/view/link.csv')).toBe(`nested/${NAME}`);
    expect(await fs.promises.exists(legacyTree)).toBe(false);
    await root.flush();
    for (const bytes of backing.values()) {
      expect(isEncryptedBlob(bytes)).toBe(true);
      const raw = new TextDecoder().decode(bytes);
      for (const marker of [REF, NAME, PAYLOAD]) expect(raw).not.toContain(marker);
    }
  });

  it('restarts an uncommitted copy from its intact source', async () => {
    const { options } = await fixture();
    await seedTree();
    await fs.promises.mkdir(destination, { recursive: true });
    await fs.promises.writeFile(`${destination}/incomplete.txt`, 'interrupted staging');
    const upper = await openWorkspaceUpper(options);
    expect(await upper.readdir('/')).not.toContain('incomplete.txt');
    expect(await fs.promises.readFile(`${destination}/nested/${NAME}`, 'utf8')).toBe(PAYLOAD);
    expect(await fs.promises.exists(legacyTree)).toBe(false);
  });

  it('resumes a durable committed destination whose interrupted cleanup left the source intact', async () => {
    const { options, root } = await fixture();
    await seedTree();
    // This is the restart state after committing but before retiring sources.
    await fs.promises.mkdir(`${destination}/nested`, { recursive: true });
    await fs.promises.writeFile(`${destination}/nested/${NAME}`, PAYLOAD);
    await fs.promises.writeFile(committed, '1');
    await root.flush();
    expect(await fs.promises.exists(committed)).toBe(true);
    expect(await fs.promises.readFile(`${destination}/nested/${NAME}`, 'utf8')).toBe(PAYLOAD);
    expect(await fs.promises.exists(legacyTree)).toBe(true);
    await openWorkspaceUpper(options);
    expect(await fs.promises.exists(legacyTree)).toBe(false);
    expect(await fs.promises.readFile(`${destination}/nested/${NAME}`, 'utf8')).toBe(PAYLOAD);
  });

  it.each([false, true])('converts legacy encrypted block directories (initial plaintext root: %s)', async (legacyConfig) => {
    const { options, key } = await fixture();
    const configured = legacyConfig ? await resolveMountConfig({ backend: InMemory }) : null;
    const blocks = configured ? (configured as unknown as { store: InMemoryStore }).store : new InMemoryStore();
    const old = await encryptedStoreMount({
      backing: configured ? { kind: 'config', config: configured } : { kind: 'store', store: blocks },
      getKey: () => key,
    });
    await old.mkdir('/nested', { uid: 0, gid: 0, mode: 0o40750 });
    const bytes = new TextEncoder().encode(PAYLOAD);
    await old.createFile(`/nested/${NAME}`, { uid: 0, gid: 0, mode: 0o100640 });
    await old.write(`/nested/${NAME}`, bytes, 0);
    await old.touch(`/nested/${NAME}`, { size: bytes.length });
    const target = new TextEncoder().encode(`nested/${NAME}`);
    await old.createFile('/link.csv', { uid: 0, gid: 0, mode: 0o120777 });
    await old.write('/link.csv', target, 0);
    await old.touch('/link.csv', { size: target.length });
    await old.flush();
    expect([...blocks.values()].some(bytes => !isEncryptedBlob(bytes))).toBe(legacyConfig);
    const legacyBlocks = `/.artipod/uppers/${await upperDirName(REF)}`;
    await fs.promises.mkdir(legacyBlocks, { recursive: true });
    for (const [id, encrypted] of blocks) await fs.promises.writeFile(`${legacyBlocks}/${id}`, encrypted);
    const upper = await openWorkspaceUpper(options);
    await fs.promises.mkdir('/view');
    mount('/view', upper);
    expect(await fs.promises.readFile(`/view/nested/${NAME}`, 'utf8')).toBe(PAYLOAD);
    expect((await fs.promises.stat('/view/nested')).mode & 0o777).toBe(0o750);
    expect(await fs.promises.readlink('/view/link.csv')).toBe(`nested/${NAME}`);
    expect(await fs.promises.exists(legacyBlocks)).toBe(false);
  });

  it('refuses conflicting tree and block sources without deleting either', async () => {
    const { options } = await fixture();
    await seedTree();
    const legacyBlocks = `/.artipod/uppers/${await upperDirName(REF)}`;
    await fs.promises.mkdir(legacyBlocks, { recursive: true });
    await expect(openWorkspaceUpper(options)).rejects.toThrow('Conflicting legacy workspace copies');
    expect(await fs.promises.readFile(`${legacyTree}/nested/${NAME}`, 'utf8')).toBe(PAYLOAD);
    expect(await fs.promises.exists(legacyBlocks)).toBe(true);
    expect(await fs.promises.exists(committed)).toBe(false);
  });
});
