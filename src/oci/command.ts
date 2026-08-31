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
import { mountOciView, mergeLayerEntries } from './view.js';
import { isDigest, type Digest } from './digest.js';
import type { SnapshotManager } from './snapshot.js';
import type { PodStore } from '../manager/pod-store.js';
import { syncRef, storeTransport, materializeImage } from '../manager/sync.js';
import { pushEncryptedRef, pullEncryptedRef, ENCRYPTED_REF_MEDIA_TYPE } from '../manager/encrypted-sync.js';
import type { LoginResult } from '../manager/authority.js';
import type { PodLocker } from '../manager/locker.js';
import type { Keyring } from '../manager/keyring.js';
import type { Hydrator } from '../manager/hydration.js';

export interface ArtipodCommandContext {
  store: OciStore;
  zfs: ZenFsLike;
  transport?: OciTransport;
  events?: PodEvents;
  snapshots?: SnapshotManager;
  /** The manager this pod syncs with (push/pull/clone). */
  remote?: PodStore;
  /** Phase 6.6: lazy hydration — index pulls, hydrate/dehydrate. */
  hydrator?: Hydrator;
  /** Phase E/F: push the open overlay's changes (merge-on-push joins heads). */
  pushBasis?: () => Promise<unknown>;
  /** Phase 6.5: login/lock/status against the pod's authority. */
  authority?: {
    /** App-provided authentication → lease + keys (crosses the wire in real deployments). */
    login: () => Promise<LoginResult>;
    locker: PodLocker;
    keyring: Keyring;
  };
}

const activeMounts = new Map<string, () => void>();

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1) => ({ stdout: '', stderr: stderr.endsWith('\n') ? stderr : `${stderr}\n`, exitCode });

const USAGE = `usage: artipod <image|layer|snapshot|commit|compact|gc> …
  image pull <ref>                     pull through the configured transport
  image ls                             list pulled refs
  image inspect <ref>                  manifest + layer summary
  image history <ref>                  layers bottom→top (use --through with mount)
  image mount <ref> [path] [--through N]
  image umount <path>
  layer inspect <diffid>               entries of one layer index
  layer mount <diffid> [path]          mount a single layer read-only
  snapshot create [label]              capture the workspace (diff vs HEAD)
  snapshot ls                          list snapshots
  snapshot diff <id> [id2]             changed paths (vs worktree when id2 omitted)
  snapshot mount <id> [path]           zero-copy read-only mount of a snapshot
  snapshot checkout <id> [path]        materialize a NEW writable branch
  commit --tag <name> [--layer-group <glob>]…  freeze the workspace into a volume image
                                       (groups → dedicated lazy layers, 6.6)
  compact                              squash the snapshot chain into one layer
  gc                                   delete unreachable blobs, report bytes
  push <ref>                           sync a ref to the manager (missing digests only)
  pull <ref>                           sync a ref from the manager + index it
  clone <ref> [path]                   materialize a ref as a writable tree
  login                                authenticate → lease → keyring populated
  lock [--all|<pod>]                   drop keys now (reads fail EACCES until login)
  status                               lease + capability expiries (also /proc/keys)
  image pull <ref> --index             index-level pull: metadata + placeholders only
  hydrate <ref> <path|glob>            fetch the lazy layers backing matching paths
  dehydrate <ref> <glob>               evict layer blobs; placeholders + indexes stay
  open <ref> [path]                    writable overlay on a lazy basis (pulls index if needed)
  files [<ref>]                        per-file local/remote hydration state
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
    const { store, zfs, transport, events, snapshots, remote, authority, hydrator, pushBasis } = podContext;
    const [group, sub, ...rest] = args;

    try {
      if (group === 'login') {
        if (!authority) return fail('artipod: no authority configured for this pod (set authority in pod options)');
        const result = await authority.login();
        await authority.locker.adoptLogin(result);
        return ok(`lease for ${result.lease.principal}: pods [${result.lease.podIds.join(', ')}] until ${result.lease.expiresAt}\n`);
      }

      if (group === 'lock') {
        if (!authority) return fail('artipod: no authority configured for this pod');
        const target = sub === '--all' || !sub ? undefined : sub;
        await authority.locker.lock(target);
        return ok(`locked ${target ?? 'all pods'} — keys dropped from the keyring\n`);
      }

      if (group === 'status') {
        if (!authority) return fail('artipod: no authority configured for this pod');
        const entries = authority.keyring.list();
        if (entries.length === 0) return ok('locked — no live leases or capabilities (artipod login to restore)\n');
        const lines = entries.map((e) => `${e.kind.padEnd(10)} ${e.name.padEnd(32)} expires ${new Date(e.expiresAt).toISOString()}`);
        return ok(`${lines.join('\n')}\n`);
      }

      if (group === 'push') {
        if (!sub) return fail('usage: artipod push <ref>');
        if (!remote) return fail('artipod: no manager configured for this pod (set sync.remote)');
        if (store.encrypted) {
          // Sync and relays move ciphertext only (docs/encryption.md).
          const result = await pushEncryptedRef(store, remote, sub, store.sessionKey);
          return ok(`pushed ${sub} (encrypted): ${result.moved} blobs moved (${result.movedBytes} bytes ciphertext), ${result.skipped} already there\n`);
        }
        const result = await syncRef(store, remote, sub);
        if (!result.complete) {
          return ok(`pushed ${sub} (partial): ${result.moved} blobs moved (${result.movedBytes} bytes), ${result.remaining} deferred by budget\n`);
        }
        return ok(`pushed ${sub}: ${result.moved} blobs moved (${result.movedBytes} bytes), ${result.skipped} already there\n`);
      }

      if (group === 'pull' && sub) {
        if (!remote) return fail('artipod: no manager configured for this pod (set sync.remote)');
        const remoteRef = await remote.getRef(sub);
        if (remoteRef?.mediaType === ENCRYPTED_REF_MEDIA_TYPE) {
          if (!store.encrypted) return fail(`artipod: '${sub}' is an encrypted ref — this pod holds no key (artipod login first)`);
          const result = await pullEncryptedRef(remote, store, sub, store.sessionKey);
          events?.emit('fs:changed', { origin: 'exec' });
          return ok(`pulled ${sub} (encrypted): ${result.moved} blobs moved, ${result.skipped} already there\n`);
        }
        const lines: string[] = [];
        const result = await pullImage({
          store,
          transport: storeTransport(remote),
          ref: sub,
          onProgress: (m) => lines.push(m),
        });
        // keep the caller's literal ref name usable for mount
        await store.putRef(sub, result.manifestDigest, 'application/vnd.oci.image.manifest.v1+json');
        events?.emit('fs:changed', { origin: 'exec' });
        return ok(`${lines.join('\n')}\npulled ${sub} (${result.layers.length} layers)\nmount it with: artipod image mount ${sub}\n`);
      }

      if (group === 'clone') {
        if (!sub) return fail('usage: artipod clone <ref> [path]');
        if (remote && !(await store.getRef(sub))) {
          const result = await pullImage({ store, transport: storeTransport(remote), ref: sub });
          await store.putRef(sub, result.manifestDigest, 'application/vnd.oci.image.manifest.v1+json');
        }
        const at = rest[0] ?? `/clones/${sanitizeRefForPath(sub)}`;
        const result = await materializeImage({ store, zfs, refOrDigest: sub, at });
        events?.emit('fs:changed', { origin: 'exec' });
        return ok(`cloned ${sub} into ${at} (${result.files} files, writable)\n`);
      }

      if (group === 'snapshot' && snapshots) {
        if (sub === 'create') {
          const snap = await snapshots.create({ label: rest.join(' ') || undefined });
          return ok(`snapshot ${snap!.id} created (${snap!.diff.entryCount} changed entries, ${snap!.diff.size} bytes diff)\n`);
        }
        if (sub === 'ls') {
          const list = await snapshots.list();
          if (!list.length) return ok('no snapshots\n');
          return ok(
            renderTable(
              ['ID', 'PARENT', 'ORIGIN', 'ENTRIES', 'CREATED', 'LABEL'],
              list.map((s) => [s.id, s.parent ?? '-', s.origin, String(s.diff.entryCount), s.createdAt, s.label ?? '']),
            ),
          );
        }
        if (sub === 'diff') {
          if (!rest[0]) return fail('usage: artipod snapshot diff <id> [id2]');
          const d = await snapshots.diff(rest[0], rest[1]);
          const lines = [
            ...d.added.map((p) => `A ${p}`),
            ...d.modified.map((p) => `M ${p}`),
            ...d.deleted.map((p) => `D ${p}`),
          ];
          return ok(lines.length ? lines.join('\n') + '\n' : 'no changes\n');
        }
        if (sub === 'mount') {
          if (!rest[0]) return fail('usage: artipod snapshot mount <id> [path]');
          const { at, unmount } = await snapshots.mount(rest[0], rest[1]);
          activeMounts.get(at)?.();
          activeMounts.set(at, unmount);
          events?.emit('fs:changed', { origin: 'exec' });
          return ok(`mounted snapshot ${rest[0]} (read-only) at ${at}\n`);
        }
        if (sub === 'checkout') {
          if (!rest[0]) return fail('usage: artipod snapshot checkout <id> [path]');
          const at = await snapshots.checkout(rest[0], rest[1]);
          events?.emit('fs:changed', { origin: 'exec' });
          return ok(`checked out ${rest[0]} into ${at} (writable branch; history untouched)\n`);
        }
      }

      if (group === 'commit' && snapshots) {
        const tagIdx = args.indexOf('--tag');
        const tag = tagIdx !== -1 ? args[tagIdx + 1] : undefined;
        if (!tag) return fail('usage: artipod commit --tag <name> [--layer-group <glob>]…');
        const layerGroups: string[] = [];
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--layer-group' && args[i + 1]) layerGroups.push(args[++i]);
        }
        const result = await snapshots.commit(tag, { layerGroups });
        events?.emit('fs:changed', { origin: 'exec' });
        return ok(
          `committed ${tag}\n  manifest: ${result.manifestDigest}\n  layers: ${result.layers} (${result.size} bytes gzip total)\nmount it with: artipod image mount ${tag}\n`,
        );
      }

      if (group === 'compact' && snapshots) {
        const snap = await snapshots.compact();
        events?.emit('fs:changed', { origin: 'exec' });
        return ok(`compacted chain → ${snap.id} (${snap.diff.entryCount} entries, ${snap.diff.size} bytes; superseded blobs are gc-able)\n`);
      }

      if (group === 'gc' && snapshots) {
        const result = await snapshots.gc();
        return ok(`gc: deleted ${result.deleted} objects, reclaimed ${result.reclaimedBytes} bytes\n`);
      }

      if (group === 'open') {
        if (!hydrator) return fail('artipod: no hydrator configured for this pod (set hydration in pod options)');
        if (!sub) return fail('usage: artipod open <ref> [path]');
        let state = await hydrator.stateFor(sub);
        let pulled = '';
        // Diverged local changes push first — the manager joins heads
        // (merge-on-push, Phase F) and the pull below adopts the merged head.
        if (state && hydrator.overlays.has(sub) && pushBasis) await pushBasis();
        // Refresh when the manager's head moved (a republish or another actor's push).
        const remoteHead = remote ? await remote.getRef(sub).catch(() => null) : null;
        if (!state || (remoteHead && remoteHead.manifestDigest !== state.manifestDigest)) {
          const result = await hydrator.pullIndex(sub);
          state = result.state;
          pulled = `index-level pull of ${sub}: ${result.transferredBytes} bytes moved\n`;
        }
        const at = rest.find((a) => a.startsWith('/')) ?? `/open/${sanitizeRefForPath(sub)}`;
        await hydrator.openOverlay(sub, at);
        events?.emit('fs:changed', { origin: 'exec' });
        const remoteCount = (await hydrator.dehydratedPaths(sub)).length;
        return ok(`${pulled}opened ${sub} at ${at} — writable overlay on a lazy basis (${remoteCount} file(s) still remote)\ncd ${at}\n`);
      }

      if (group === 'files') {
        if (!hydrator) return fail('artipod: no hydrator configured for this pod (set hydration in pod options)');
        const refArg = sub ?? (hydrator.overlays.size === 1 ? [...hydrator.overlays.keys()][0] : undefined);
        if (!refArg) return fail('usage: artipod files <ref>   (ref optional with exactly one open overlay)');
        const { layers, state } = await hydrator.loadView(refArg);
        const merged = mergeLayerEntries(layers);
        const rows = [...merged.entries.entries()]
          .filter(([, e]) => e.type !== 'dir')
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, e]) => [
            state.layers[e.layer]?.state === 'placeholder' ? 'remote' : 'local',
            String(e.size),
            path,
          ]);
        const capped = rows.slice(0, 500);
        return ok(
          renderTable(['STATE', 'SIZE', 'PATH'], capped) +
            (rows.length > capped.length ? `\n…and ${rows.length - capped.length} more\n` : '\n'),
        );
      }

      if (group === 'hydrate') {
        if (!hydrator) return fail('artipod: no hydrator configured for this pod (set hydration in pod options)');
        if (!sub || !rest[0]) return fail('usage: artipod hydrate <ref> <path|glob>');
        const result = await hydrator.hydrate(sub, rest[0]);
        events?.emit('fs:changed', { origin: 'exec' });
        return ok(`hydrated ${result.layers} layer(s), ${result.bytes} bytes fetched\n`);
      }

      if (group === 'dehydrate') {
        if (!hydrator) return fail('artipod: no hydrator configured for this pod (set hydration in pod options)');
        if (!sub || !rest[0]) return fail('usage: artipod dehydrate <ref> <glob>');
        const result = await hydrator.dehydrate(sub, rest[0]);
        events?.emit('fs:changed', { origin: 'exec' });
        return ok(`dehydrated ${result.layers} layer(s) — placeholders + indexes kept, re-hydrate any time\n`);
      }

      if (group === 'image' && sub === 'pull' && rest.includes('--index')) {
        const refArg = rest[0];
        if (!refArg || refArg === '--index') return fail('usage: artipod image pull <ref> --index');
        if (!hydrator) return fail('artipod: no hydrator configured for this pod (set hydration in pod options)');
        const result = await hydrator.pullIndex(refArg);
        events?.emit('fs:changed', { origin: 'exec' });
        const placeholders = result.state.layers.filter((l) => l.state === 'placeholder').length;
        return ok(
          `index-level pull of ${refArg}: ${result.transferredBytes} bytes moved, ${result.state.layers.length} layers (${placeholders} placeholder)\nmount it with: artipod image mount ${refArg}\n`,
        );
      }

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
        // Index-pulled refs mount through the hydrator: placeholders read as
        // fail-fast, and hydrate/dehydrate refresh the live view in place.
        const hydrationState = hydrator ? await hydrator.stateFor(refArg) : null;
        if (hydrationState && hydrator) {
          await hydrator.mount(refArg, at);
          activeMounts.get(at)?.();
          activeMounts.set(at, () => hydrator.unmount(refArg));
          events?.emit('fs:changed', { origin: 'exec' });
          const placeholders = hydrationState.layers.filter((l) => l.state === 'placeholder').length;
          return ok(
            `mounted ${found.display} (${hydrationState.layers.length} layers, ${placeholders} dehydrated, read-only) at ${at}\n`,
          );
        }
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
