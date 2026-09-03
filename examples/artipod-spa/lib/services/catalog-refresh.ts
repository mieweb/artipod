/**
 * Catalog local-side refresh (spa-ui-plan U2, ported from the old app's
 * refreshLocal + verdict effects): rescans "on this machine" (fs is the
 * source of truth, the registry is a cache — rm -rf / must empty the
 * screen), reads local heads, detects real upper changes, sweeps dead
 * blanks, reconciles published blanks by content address, then applies
 * ancestry verdicts and heals stale registry flags.
 */
import { catalogStore, type SyncVerdict } from '../stores/catalog';
import { registryStore } from '../stores/registry';
import { boundAncestry, computeVerdicts, healUnsynced } from './catalog-service';
import { upperDirName, type LocalEntry } from './ui-state';
import { keys, uiState } from '../boot';
import { initFileSystem } from '../filesystem';

/** Ids whose workspace tab is still alive (it holds a Web Lock for its lifetime). */
export const wsLockName = (id: string): string => `artipod-ws-${id}`;

async function liveWorkspaceIds(): Promise<Set<string>> {
  try {
    const { held } = await navigator.locks.query();
    return new Set(
      (held ?? [])
        .map((l) => l.name ?? '')
        .filter((n) => n.startsWith('artipod-ws-'))
        .map((n) => n.slice('artipod-ws-'.length)),
    );
  } catch {
    return new Set(); // no Web Locks — skip sweeping rather than risk a live tab
  }
}

/** Rescan "on this machine" — at load and after every console command. */
export async function refreshLocal(): Promise<void> {
  const { io, registry: actions } = await uiState();
  const registry = (await io.read()).workspaces;
  const onDisk: string[] = [];
  const swept: string[] = [];
  let changed = new Set(registry.filter((e) => e.hasChanges).map((e) => e.id));
  try {
    const info = await initFileSystem();
    const { fs } = await import('../filesystem');
    // the toggle writes the pod setting (same file `artipod offline` uses) —
    // without this, a reload's fs reconcile would stomp the mirror
    keys().setOfflineWriter(async (value) => {
      const { writePodSettings } = await import('@artipod/core/oci');
      await writePodSettings(fs as unknown as Parameters<typeof writePodSettings>[0], { offline: value });
    });
    // shells write the offline setting into the pod fs — adopt it (chip flips live)
    try {
      const { readPodSettings } = await import('@artipod/core/oci');
      const value = (await readPodSettings(fs as unknown as Parameters<typeof readPodSettings>[0])).offline === true;
      keys().reconcileOffline(value);
    } catch {
      // fs not initialized yet — the boot mirror stands
    }
    // local heads for the digest-verified synced badge (refs are cleartext
    // pointers — readable without a key even on encrypted stores)
    try {
      const { OciStore } = await import('@artipod/core/oci');
      const store = new OciStore(fs as unknown as ConstructorParameters<typeof OciStore>[0]);
      await store.init();
      catalogStore.setState({
        localHeads: Object.fromEntries((await store.listRefs()).map((r) => [r.ref, r.manifestDigest])),
      });
    } catch {
      // no local store yet
    }
    const dirs = (await fs.promises.readdir('/work').catch(() => [])) as string[];
    const live = await liveWorkspaceIds();
    for (const id of dirs) {
      const entries = (await fs.promises.readdir(`/work/${id}`).catch(() => null)) as string[] | null;
      if (entries && entries.length === 0 && !live.has(id)) {
        await fs.promises.rm(`/work/${id}`, { recursive: true }).catch(() => {});
        swept.push(id);
      } else {
        onDisk.push(id);
      }
    }
    await io.drop(swept);
    // Published-blank reconciliation: content addressing means "is this
    // already on the server?" is a pure comparison — a blank whose file set
    // (path + mtime) matches a server ref's manifest IS that ref.
    try {
      const serverList = (await (await fetch('/api/pods/refs')).json()) as { ref: string; manifestDigest: string }[];
      const manifests = await Promise.all(
        serverList.map(async ({ manifestDigest }) => {
          const m = (await (await fetch(`/api/pods/blobs/${manifestDigest}`)).json()) as {
            layers?: { annotations?: Record<string, string> }[];
          };
          const files = new Map<string, number>();
          for (const l of m.layers ?? []) {
            const p = l.annotations?.['org.artipod.path'];
            const t = l.annotations?.['org.artipod.mtime'];
            if (p && !p.startsWith('/.wh')) files.set(p, Number(t) || Date.parse(t ?? '') || 0);
          }
          return files;
        }),
      );
      const liveNow = await liveWorkspaceIds();
      for (const id of [...onDisk]) {
        if (id.includes(':') || liveNow.has(id)) continue; // refs and open tabs are not candidates
        const walk = async (dir: string, rel: string, out: Map<string, number>): Promise<void> => {
          for (const name of (await fs.promises.readdir(dir).catch(() => [])) as string[]) {
            const full = `${dir}/${name}`;
            const stat = await fs.promises.stat(full).catch(() => null);
            if (!stat) continue;
            if (stat.isDirectory()) await walk(full, `${rel}/${name}`, out);
            else out.set(`${rel}/${name}`, Number(stat.mtimeMs));
          }
        };
        const localFiles = new Map<string, number>();
        await walk(`/work/${id}`, '', localFiles);
        if (localFiles.size === 0) continue;
        // tar mtimes are second-granular — compare with 2s tolerance
        const matches = manifests.some(
          (files) =>
            files.size === localFiles.size &&
            Array.from(localFiles.entries()).every(([p, t]) => files.has(p) && Math.abs((files.get(p) ?? 0) - t) < 2000),
        );
        if (matches) {
          await fs.promises.rm(`/work/${id}`, { recursive: true }).catch(() => {});
          swept.push(id);
          onDisk.splice(onDisk.indexOf(id), 1);
        }
      }
      await io.drop(swept);
    } catch {
      // offline or no server — reconciliation is best-effort
    }
    // Physical cow uppers: legacy plaintext dirs are named by ref; broker-mode
    // block stores are hash-named and OPAQUE — the physical dir only vetoes
    // (gone/empty = no changes), the registry flag is the verdict.
    if (info?.backend === 'opfs') {
      changed = new Set<string>();
      const modeById = new Map(registry.map((e) => [e.id, e.mode]));
      const upperNames = new Set((await fs.promises.readdir('/.artipod/uppers').catch(() => [])) as string[]);
      for (const e of registry) {
        if (modeById.get(e.id) === 'rw') continue; // autoPush keeps rw synced
        const legacy = encodeURIComponent(e.id);
        const hashed = await upperDirName(e.id);
        const name = upperNames.has(legacy) ? legacy : upperNames.has(hashed) ? hashed : null;
        if (!name) continue;
        const entries = (await fs.promises.readdir(`/.artipod/uppers/${name}`).catch(() => [])) as string[];
        if (entries.length === 0) continue;
        if (name === legacy || e.hasChanges) changed.add(e.id);
      }
      for (const e of registry) {
        if (e.hasChanges && !changed.has(e.id)) await io.patch(e.id, { hasChanges: false });
      }
    }
  } catch {
    // no /work yet (or init failed) — registry alone
  }
  catalogStore.setState({ changedRefs: Array.from(changed) });
  // Snapshot: registry entries filtered to what actually exists, plus
  // unregistered on-disk blanks.
  const current = (await io.read()).workspaces;
  const byId = new Map<string, LocalEntry>(
    current.filter((e) => !swept.includes(e.id) && (e.kind === 'pod' || onDisk.includes(e.id))).map((e) => [e.id, e]),
  );
  for (const id of onDisk) {
    if (!byId.has(id)) byId.set(id, { id, kind: 'blank', lastOpened: 0 });
  }
  registryStore.setState({
    entries: Array.from(byId.values()).sort((a, b) => b.lastOpened - a.lastOpened),
    actor: (await io.read()).actor ?? null,
  });
  void actions; // reserved: mutations above go through io directly
}

/** Ancestry verdicts + registry heal (runs after server refs and local heads exist). */
export async function refreshVerdicts(): Promise<void> {
  const { serverRefs, localHeads } = catalogStore.getState();
  if (!serverRefs || Object.keys(localHeads).length === 0) return;
  try {
    const { fs } = await import('../filesystem');
    const isAncestor = await boundAncestry(fs, () => keys().getKey());
    const verdicts = await computeVerdicts({
      serverRefs: serverRefs.filter((r) => !!r.manifestDigest),
      localHeads: new Map(Object.entries(localHeads)),
      isAncestor,
    });
    catalogStore.setState({ verdicts: Object.fromEntries(verdicts) as Record<string, SyncVerdict> });
    const { io } = await uiState();
    const entries = registryStore.getState().entries;
    for (const id of healUnsynced(entries, verdicts)) await io.patch(id, { unsynced: false });
  } catch {
    // fs not ready — flags stand
  }
}
