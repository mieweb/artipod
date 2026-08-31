/**
 * The `artipod` shell command (issue #1's surface):
 *   artipod image pull <ref>
 *   artipod image ls
 *   artipod image inspect <ref>
 *   artipod image history <ref>
 *   artipod image mount <ref> [path] [--through N]
 *   artipod layer inspect <diffid>
 *   artipod layer mount <diffid> [path]
 *   artipod image umount <path>
 */

import { defineCommand } from 'just-bash/browser';
import type { ZenFsLike } from '../sandbox/types.js';
import type { PodEvents } from '../events.js';
import { renderTable } from '../sandbox/table.js';
import type { OciStore } from './store.js';
import type { OciTransport } from './transport.js';
import { parseImageRef, formatImageRef } from './transport.js';
import { pullImage, loadImageLayers, type ImageManifest } from './pull.js';
import { mountOciView } from './view.js';
import { isDigest, type Digest } from './digest.js';

export interface ArtipodCommandContext {
  store: OciStore;
  zfs: ZenFsLike;
  transport?: OciTransport;
  events?: PodEvents;
}

const activeMounts = new Map<string, () => void>();

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1) => ({ stdout: '', stderr: stderr.endsWith('\n') ? stderr : `${stderr}\n`, exitCode });

const USAGE = `usage: artipod <image|layer> <subcommand>
  image pull <ref>                     pull through the configured transport
  image ls                             list pulled refs
  image inspect <ref>                  manifest + layer summary
  image history <ref>                  layers bottom→top (use --through with mount)
  image mount <ref> [path] [--through N]
  image umount <path>
  layer inspect <diffid>               entries of one layer index
  layer mount <diffid> [path]          mount a single layer read-only
`;

function sanitizeRefForPath(ref: string): string {
  return ref.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

async function resolveStoredRef(store: OciStore, refArg: string): Promise<{ display: string; manifestDigest: Digest } | null> {
  if (isDigest(refArg)) return { display: refArg, manifestDigest: refArg };
  const canonical = formatImageRef(parseImageRef(refArg));
  const stored = (await store.getRef(canonical)) ?? (await store.getRef(refArg));
  return stored ? { display: stored.ref, manifestDigest: stored.manifestDigest } : null;
}

export const makeArtipodCommand = (podContext: ArtipodCommandContext) =>
  defineCommand('artipod', async (args) => {
    const { store, zfs, transport, events } = podContext;
    const [group, sub, ...rest] = args;

    try {
      if (group === 'image' && sub === 'pull') {
        const refArg = rest[0];
        if (!refArg) return fail('usage: artipod image pull <ref>');
        if (!transport) return fail('artipod: no transport configured for this pod (set oci.transport)');
        const lines: string[] = [];
        const result = await pullImage({
          store,
          transport,
          ref: refArg,
          onProgress: (m) => lines.push(m),
        });
        events?.emit('fs:changed', { origin: 'exec' });
        lines.push(
          renderTable(
            ['LAYER', 'DIFF ID', 'SIZE', 'ENTRIES'],
            result.layers.map((l, i) => [String(i), l.diffId.slice(0, 19) + '…', String(l.size), String(l.entryCount)]),
          ),
        );
        lines.push(`manifest: ${result.manifestDigest}`);
        return ok(lines.join('\n') + '\n');
      }

      if (group === 'image' && sub === 'ls') {
        const refs = await store.listRefs();
        if (!refs.length) return ok('no images pulled\n');
        return ok(
          renderTable(
            ['REF', 'MANIFEST', 'PULLED'],
            refs.map((r) => [r.ref, r.manifestDigest.slice(0, 19) + '…', r.pulledAt]),
          ) + '\n',
        );
      }

      if (group === 'image' && (sub === 'inspect' || sub === 'history')) {
        const refArg = rest[0];
        if (!refArg) return fail(`usage: artipod image ${sub} <ref>`);
        const found = await resolveStoredRef(store, refArg);
        if (!found) return fail(`artipod: '${refArg}' is not pulled (try: artipod image pull ${refArg})`);
        const manifest = JSON.parse(new TextDecoder().decode(await store.getBlob(found.manifestDigest))) as ImageManifest;
        if (sub === 'inspect') {
          return ok(JSON.stringify({ ref: found.display, manifestDigest: found.manifestDigest, manifest }, null, 2) + '\n');
        }
        const { diffIds, layers } = await loadImageLayers(store, found.manifestDigest);
        return ok(
          renderTable(
            ['N', 'DIFF ID', 'ENTRIES'],
            diffIds.map((d, i) => [String(i + 1), d.slice(0, 19) + '…', String(layers[i].length)]),
          ) + '\nmount a prefix with: artipod image mount <ref> [path] --through N\n',
        );
      }

      if (group === 'image' && sub === 'mount') {
        const refArg = rest[0];
        if (!refArg) return fail('usage: artipod image mount <ref> [path] [--through N]');
        const throughIdx = rest.indexOf('--through');
        let through: number | undefined;
        let restArgs = rest.slice(1);
        if (throughIdx !== -1) {
          through = parseInt(rest[throughIdx + 1] ?? '', 10);
          if (!Number.isFinite(through) || through < 0) return fail('artipod: --through needs a non-negative number');
          restArgs = rest.slice(1).filter((_, i) => i + 1 !== throughIdx && i + 1 !== throughIdx + 1);
        }
        const at = restArgs.find((a) => a.startsWith('/')) ?? `/mnt/oci/images/${sanitizeRefForPath(refArg)}${through !== undefined ? `@${through}` : ''}`;
        const found = await resolveStoredRef(store, refArg);
        if (!found) return fail(`artipod: '${refArg}' is not pulled (try: artipod image pull ${refArg})`);
        const { layers, layerBytes } = await loadImageLayers(store, found.manifestDigest);
        const unmount = await mountOciView({ zfs, at, layers, layerBytes, through, name: sanitizeRefForPath(found.display) });
        activeMounts.get(at)?.();
        activeMounts.set(at, unmount);
        events?.emit('fs:changed', { origin: 'exec' });
        const n = through ?? layers.length;
        return ok(`mounted ${found.display} (${n}/${layers.length} layers, read-only) at ${at}\n`);
      }

      if (group === 'image' && sub === 'umount') {
        const at = rest[0];
        if (!at) return fail('usage: artipod image umount <path>');
        const unmount = activeMounts.get(at);
        if (!unmount) return fail(`artipod: nothing mounted at ${at}`);
        unmount();
        activeMounts.delete(at);
        events?.emit('fs:changed', { origin: 'exec' });
        return ok(`unmounted ${at}\n`);
      }

      if (group === 'layer' && (sub === 'inspect' || sub === 'mount')) {
        const diffArg = rest[0];
        if (!diffArg || !isDigest(diffArg)) return fail(`usage: artipod layer ${sub} <sha256:diffid>`);
        const index = await store.getLayerIndex(diffArg);
        if (sub === 'inspect') {
          return ok(
            renderTable(
              ['TYPE', 'SIZE', 'PATH'],
              index.entries.slice(0, 200).map((e) => [e.type, String(e.size), e.path + (e.linkTarget ? ` → ${e.linkTarget}` : '')]),
            ) + (index.entries.length > 200 ? `\n…and ${index.entries.length - 200} more\n` : '\n'),
          );
        }
        const at = rest.find((a, i) => i > 0 && a.startsWith('/')) ?? `/mnt/oci/layers/${diffArg.slice(7, 19)}`;
        const bytes = await store.getUncompressed(diffArg);
        const unmount = await mountOciView({ zfs, at, layers: [index.entries], layerBytes: [bytes], name: `layer-${diffArg.slice(7, 15)}` });
        activeMounts.get(at)?.();
        activeMounts.set(at, unmount);
        events?.emit('fs:changed', { origin: 'exec' });
        return ok(`mounted layer ${diffArg.slice(0, 19)}… (read-only) at ${at}\n`);
      }

      return fail(USAGE);
    } catch (error) {
      return fail(`artipod: ${(error as Error).message}`);
    }
  });
