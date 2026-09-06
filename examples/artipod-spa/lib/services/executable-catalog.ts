import { createStore } from 'zustand/vanilla';
import { parseExecutableDescriptor, inspectApplication, type ApplicationFiles, type ExecutableDescriptor } from '@artipod/core/apps';
import { catalogStore } from '../stores/catalog';
import { registryStore } from '../stores/registry';

export const executableStore = createStore<{ applications: Record<string, ExecutableDescriptor> }>(() => ({ applications: {} }));
let refreshGeneration = 0;
const published = new Map<string, ExecutableDescriptor | null>();

export async function workspaceFiles(): Promise<ApplicationFiles> {
  const filesystem = await import('../filesystem');
  await filesystem.initFileSystem();
  const { fs } = filesystem;
  return {
    read: async path => new Uint8Array(await fs.promises.readFile(path)),
    list: async path => await fs.promises.readdir(path) as string[],
    stat: async path => await fs.promises.lstat(path),
  };
}

export async function inspectPublishedApplication(manifestDigest: string): Promise<ExecutableDescriptor | null> {
  const { boundedResponse } = await import('@artipod/core/apps');
  const { verifyDigest, indexTar, mergeLayerEntries, isGzip } = await import('@artipod/core/oci');
  const readBlob = async (digest: string, limit: number) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid digest');
    const bytes = await boundedResponse(await fetch(`/api/pods/blobs/${digest}`, { signal: AbortSignal.timeout(5000) }), limit);
    await verifyDigest(bytes, digest as `sha256:${string}`);
    return bytes;
  };
  const manifest = JSON.parse(new TextDecoder().decode(await readBlob(manifestDigest, 256 * 1024))) as {
    layers?: { digest: string; size: number; annotations?: Record<string, string> }[];
  };
  if (!Array.isArray(manifest.layers) || manifest.layers.length > 128) return null;
  const layers: Uint8Array[] = [];
  let total = 0;
  let expanded = 0;
  for (const layer of manifest.layers) {
    const path = layer.annotations?.['org.artipod.path'];
    if (path && path !== '/artipod.json' && path !== 'artipod.json' && !path.includes('.wh.')) continue;
    if (!Number.isSafeInteger(layer.size) || layer.size < 0 || layer.size > 256 * 1024 || (total += layer.size) > 1024 * 1024) return null;
    let bytes = await readBlob(layer.digest, 256 * 1024);
    if (isGzip(bytes)) {
      const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = await boundedResponse(new Response(stream), 1024 * 1024);
    }
    expanded += bytes.byteLength;
    if (expanded > 2 * 1024 * 1024) return null;
    layers.push(bytes);
  }
  const merged = mergeLayerEntries(layers.map(bytes => indexTar(bytes)));
  const descriptor = merged.entries.get('/artipod.json');
  if (!descriptor || descriptor.type !== 'file' || descriptor.size > 65536) return null;
  return parseExecutableDescriptor(layers[descriptor.layer].slice(descriptor.offset, descriptor.offset + descriptor.size));
}

export async function refreshExecutables(): Promise<void> {
  const current = ++refreshGeneration;
  const applications: Record<string, ExecutableDescriptor> = {};
  const files = await workspaceFiles().catch(() => null);
  for (const entry of registryStore.getState().entries) {
    if (current !== refreshGeneration) return;
    if (entry.kind !== 'blank' || !files) continue;
    try { applications[entry.id] = await inspectApplication(files, `/work/${entry.id}`); } catch { /* Inert non-app or unavailable descriptor. */ }
  }
  for (const ref of catalogStore.getState().serverRefs ?? []) {
    if (current !== refreshGeneration) return;
    try {
      const descriptor = published.has(ref.manifestDigest)
        ? published.get(ref.manifestDigest)
        : await inspectPublishedApplication(ref.manifestDigest);
      if (descriptor !== undefined) {
        if (published.size >= 128) published.delete(published.keys().next().value!);
        published.set(ref.manifestDigest, descriptor);
      }
      if (descriptor) applications[ref.ref] = descriptor;
    } catch { /* Locked, offline, unsupported or malformed pods remain inspectable. */ }
  }
  if (current === refreshGeneration) executableStore.setState({ applications });
}