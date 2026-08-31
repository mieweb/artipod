/**
 * View + pull + shell integration: crafted two-layer image (whiteouts,
 * opaque dirs, symlink/hardlink), served by a scripted fake registry
 * (fetchFn stub — token dance included, zero network), pulled through the
 * transport, mounted as OciViewFS, and driven from the sandbox via the
 * `artipod` command. Tamper rejection and --through are pinned here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts } from '@zenfs/core';
import { createSandbox, type Sandbox } from '../sandbox/index.js';
import { sha256, type Digest } from './digest.js';
import { indexTar } from './tar.js';
import { mergeLayerEntries, mountOciView } from './view.js';
import { OciStore } from './store.js';
import { DirectRegistryTransport, OciLayoutTransport, parseImageRef } from './transport.js';
import { pullImage, loadImageLayers } from './pull.js';
import { makeArtipodCommand } from './command.js';
import { makeTar, gzipBytes } from './test-fixtures.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Layer 1: base files; layer 2: override + whiteout + opaque dir. */
const layer1Tar = () =>
  makeTar([
    { path: 'etc/', type: 'dir' },
    { path: 'etc/os-release', content: 'NAME="Artipod Linux"\nVERSION_ID=1\n' },
    { path: 'etc/motd', content: 'welcome to layer one\n' },
    { path: 'app/', type: 'dir' },
    { path: 'app/old.cfg', content: 'stale' },
    { path: 'app/keep.txt', content: 'kept' },
    { path: 'bin/', type: 'dir' },
    { path: 'bin/busybox', content: 'BUSYBOXELF' },
    { path: 'bin/sh', type: 'hardlink', linkTarget: 'bin/busybox' },
    { path: 'etc/alias', type: 'symlink', linkTarget: 'os-release' },
  ]);

const layer2Tar = () =>
  makeTar([
    { path: 'etc/os-release', content: 'NAME="Artipod Linux"\nVERSION_ID=2\n' },
    { path: 'etc/.wh.motd', content: '' }, // delete /etc/motd
    { path: 'app/', type: 'dir' },
    { path: 'app/.wh..wh..opq', content: '' }, // opaque: wipe /app
    { path: 'app/new.cfg', content: 'fresh' },
  ]);

interface FakeImage {
  manifestBytes: Uint8Array;
  manifestDigest: Digest;
  blobs: Map<string, Uint8Array>;
}

async function buildFakeImage(): Promise<FakeImage> {
  const blobs = new Map<string, Uint8Array>();
  const layers = [] as { digest: Digest; size: number; diffId: Digest }[];
  for (const tar of [layer1Tar(), layer2Tar()]) {
    const diffId = await sha256(tar);
    const gz = await gzipBytes(tar);
    const digest = await sha256(gz);
    blobs.set(digest, gz);
    layers.push({ digest, size: gz.length, diffId });
  }
  const config = encoder.encode(
    JSON.stringify({ architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: layers.map((l) => l.diffId) } }),
  );
  const configDigest = await sha256(config);
  blobs.set(configDigest, config);

  const manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: config.length },
    layers: layers.map((l) => ({
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: l.digest,
      size: l.size,
    })),
  };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  return { manifestBytes, manifestDigest: await sha256(manifestBytes), blobs };
}

/** Scripted registry: token dance + manifests + blobs, optional corruption. */
function fakeRegistryFetch(image: FakeImage, opts: { corruptLayers?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;

    if (url.hostname === 'auth.fake.test') {
      return new Response(JSON.stringify({ token: 'anonymous-token' }), { status: 200 });
    }
    if (!auth) {
      return new Response('unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="https://auth.fake.test/token",service="fake",scope="pull"' },
      });
    }
    const manifestMatch = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname);
    if (manifestMatch) {
      return new Response(image.manifestBytes as BodyInit, {
        status: 200,
        headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json' },
      });
    }
    const blobMatch = /^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]{64})$/.exec(url.pathname);
    if (blobMatch) {
      const bytes = image.blobs.get(blobMatch[2]);
      if (!bytes) return new Response('not found', { status: 404 });
      const body = opts.corruptLayers && bytes.length > 200 ? bytes.map((b, i) => (i === 42 ? b ^ 0xff : b)) : bytes;
      return new Response(body as BodyInit, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

let sandbox: Sandbox;
let store: OciStore;

function unmountAll() {
  for (const path of [...zenMounts.keys()]) {
    if (path !== '/') {
      try {
        umount(path);
      } catch {
        // fine
      }
    }
  }
  try {
    umount('/');
  } catch {
    // fine
  }
}

beforeEach(async () => {
  unmountAll();
  await configure({ mounts: { '/': InMemory } });
  await zfs.promises.mkdir('/repo');
  store = new OciStore(zfs);
  await store.init();
});

describe('mergeLayerEntries + OciViewFS', () => {
  it('applies overrides, whiteouts and opaque dirs; --through truncates', async () => {
    const layers = [indexTar(layer1Tar()), indexTar(layer2Tar())];
    const bytes = [layer1Tar(), layer2Tar()];

    const full = mergeLayerEntries(layers);
    expect(full.entries.get('/etc/motd')).toBeUndefined(); // whiteout
    expect(full.entries.get('/app/old.cfg')).toBeUndefined(); // opaque
    expect(full.entries.get('/app/keep.txt')).toBeUndefined(); // opaque wipes everything
    expect(full.entries.get('/app/new.cfg')).toBeDefined();

    await mountOciView({ zfs, at: '/mnt/full', layers, layerBytes: bytes });
    await mountOciView({ zfs, at: '/mnt/base', layers, layerBytes: bytes, through: 1 });

    sandbox = createSandbox({ zfs });
    const v2 = await sandbox.exec('cat /mnt/full/etc/os-release');
    expect(v2.stdout).toContain('VERSION_ID=2');
    const v1 = await sandbox.exec('cat /mnt/base/etc/os-release');
    expect(v1.stdout).toContain('VERSION_ID=1');
    expect((await sandbox.exec('cat /mnt/base/etc/motd')).stdout).toContain('layer one');
    expect((await sandbox.exec('cat /mnt/full/etc/motd')).exitCode).not.toBe(0);
    expect((await sandbox.exec('ls /mnt/full/app')).stdout.trim()).toBe('new.cfg');
    // hardlink + symlink resolve
    expect((await sandbox.exec('cat /mnt/full/bin/sh')).stdout).toBe('BUSYBOXELF');
    expect((await sandbox.exec('cat /mnt/full/etc/alias')).stdout).toContain('VERSION_ID=2');
    // read-only: writes fail
    expect((await sandbox.exec('sh -c "echo x > /mnt/full/etc/new"')).exitCode).not.toBe(0);
  });
});

describe('pullImage through the registry transport', () => {
  it('pulls, verifies, indexes and mounts via the artipod command', async () => {
    const image = await buildFakeImage();
    const transport = new DirectRegistryTransport({ fetchFn: fakeRegistryFetch(image) });
    sandbox = createSandbox({
      zfs,
      extraCommands: [makeArtipodCommand({ store, zfs, transport })],
    });

    const pull = await sandbox.exec('artipod image pull fake.test/demo/app:1.0');
    expect(pull.exitCode).toBe(0);
    expect(pull.stdout).toContain('pulled fake.test/demo/app:1.0 (2 layers)');

    const ls = await sandbox.exec('artipod image ls');
    expect(ls.stdout).toContain('fake.test/demo/app:1.0');

    const history = await sandbox.exec('artipod image history fake.test/demo/app:1.0');
    expect(history.exitCode).toBe(0);
    expect(history.stdout).toMatch(/1 .*sha256:/);

    const mountR = await sandbox.exec('artipod image mount fake.test/demo/app:1.0 /mnt/app');
    expect(mountR.exitCode).toBe(0);
    expect((await sandbox.exec('cat /mnt/app/etc/os-release')).stdout).toContain('VERSION_ID=2');

    const through = await sandbox.exec('artipod image mount fake.test/demo/app:1.0 /mnt/app1 --through 1');
    expect(through.exitCode).toBe(0);
    expect((await sandbox.exec('cat /mnt/app1/etc/os-release')).stdout).toContain('VERSION_ID=1');

    const umountR = await sandbox.exec('artipod image umount /mnt/app1');
    expect(umountR.exitCode).toBe(0);
    expect((await sandbox.exec('cat /mnt/app1/etc/os-release')).exitCode).not.toBe(0);
  });

  it('rejects tampered layer blobs at the store boundary', async () => {
    const image = await buildFakeImage();
    const transport = new DirectRegistryTransport({ fetchFn: fakeRegistryFetch(image, { corruptLayers: true }) });
    await expect(pullImage({ store, transport, ref: 'fake.test/demo/app:1.0' })).rejects.toThrow(/mismatch|tampered/);
  });

  it('pulls from an OCI image-layout directory (local import)', async () => {
    const image = await buildFakeImage();
    // write a layout into the pod fs (as a hostDir mount would present it)
    const dir = '/imports/app';
    await zfs.promises.mkdir(`${dir}/blobs/sha256`, { recursive: true });
    await zfs.promises.writeFile(`${dir}/oci-layout`, JSON.stringify({ imageLayoutVersion: '1.0.0' }));
    await zfs.promises.writeFile(
      `${dir}/index.json`,
      JSON.stringify({
        schemaVersion: 2,
        manifests: [
          {
            mediaType: 'application/vnd.oci.image.manifest.v1+json',
            digest: image.manifestDigest,
            size: image.manifestBytes.length,
            annotations: { 'org.opencontainers.image.ref.name': '1.0' },
          },
        ],
      }),
    );
    await zfs.promises.writeFile(`${dir}/blobs/sha256/${image.manifestDigest.slice(7)}`, image.manifestBytes);
    for (const [digest, bytes] of image.blobs) {
      await zfs.promises.writeFile(`${dir}/blobs/sha256/${digest.slice(7)}`, bytes);
    }

    const layout = new OciLayoutTransport(
      {
        readFile: async (p) => {
          const b = (await zfs.promises.readFile(p)) as Uint8Array;
          return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        },
        readFileText: async (p) => (await zfs.promises.readFile(p, 'utf8')) as string,
      },
      dir,
    );
    const result = await pullImage({ store, transport: layout, ref: parseImageRef('imported/app:1.0') });
    expect(result.layers).toHaveLength(2);
    const { layers, layerBytes } = await loadImageLayers(store, result.manifestDigest);
    await mountOciView({ zfs, at: '/mnt/imported', layers, layerBytes });
    sandbox = createSandbox({ zfs });
    expect((await sandbox.exec('cat /mnt/imported/app/new.cfg')).stdout).toBe('fresh');
  });

  it('blobs, indexes and refs survive a reload (new store over same fs)', async () => {
    const image = await buildFakeImage();
    const transport = new DirectRegistryTransport({ fetchFn: fakeRegistryFetch(image) });
    const result = await pullImage({ store, transport, ref: 'fake.test/demo/app:1.0' });

    const reloaded = new OciStore(zfs);
    await reloaded.init();
    const refs = await reloaded.listRefs();
    expect(refs.map((r) => r.ref)).toContain('fake.test/demo/app:1.0');
    const { layers, layerBytes } = await loadImageLayers(reloaded, result.manifestDigest);
    await mountOciView({ zfs, at: '/mnt/after-reload', layers, layerBytes });
    sandbox = createSandbox({ zfs });
    expect((await sandbox.exec('cat /mnt/after-reload/etc/os-release')).stdout).toContain('VERSION_ID=2');
  });
});

describe('parseImageRef', () => {
  it('parses hosts, library shorthand, tags and digests', async () => {
    expect(parseImageRef('alpine')).toMatchObject({ host: 'docker.io', repo: 'library/alpine', tag: 'latest' });
    expect(parseImageRef('docker.io/library/alpine:3.22')).toMatchObject({ repo: 'library/alpine', tag: '3.22' });
    expect(parseImageRef('ghcr.io/org/app:v1')).toMatchObject({ host: 'ghcr.io', repo: 'org/app', tag: 'v1' });
    const d = await sha256(encoder.encode('x'));
    expect(parseImageRef(`quay.io/a/b@${d}`).digest).toBe(d);
    expect(decoder.decode(new Uint8Array(0))).toBe(''); // keep decoder referenced
  });
});
