/**
 * Catalog local-side refresh (spa-ui-plan U2, ported from the old app's
 * refreshLocal + verdict effects): rescans "on this machine" (fs is the
 * source of truth, the registry is a cache — rm -rf / must empty the
 * screen), reads local heads, detects real upper changes, filters dead
 * blanks, reconciles published blanks by content address, then applies
 * ancestry verdicts. Snapshot-derived badges never acknowledge durable writes.
 */
import { catalogStore, refreshServer, type SyncVerdict } from '../stores/catalog';
import { registryStore } from '../stores/registry';
import { boundAncestry, computeVerdicts } from './catalog-service';
import { upperDirName, type LocalEntry } from './ui-state';
import { keys, uiState } from '../boot';
import { initFileSystem } from '../filesystem';
import { workspaceUpperPaths } from './workspace-storage';
import { hostSave } from './host-save';

/** Ids whose workspace tab is still alive (it holds a Web Lock for its lifetime). */
export const wsLockName = (id: string): string => `artipod-ws-${id}`;

async function liveWorkspaceIds(): Promise<Set<string> | null> {
  try {
    const { held } = await navigator.locks.query();
    return new Set(
      (held ?? [])
        .map((l) => l.name ?? '')
        .filter((n) => n.startsWith('artipod-ws-'))
        .map((n) => n.slice('artipod-ws-'.length)),
    );
  } catch {
    return null; // no Web Locks — skip sweeping rather than risk a live tab
  }
}

/** One catalog mount owns server requests, its initial scan and console rescans. */
export function createCatalogRefresh() {
  let disposed = false;
  let scanRevision = 0;
  let serverRevision = 0;
  const scan = async (): Promise<void> => {
    if (disposed) return;
    const revision = ++scanRevision;
    const isActive = () => !disposed && revision === scanRevision;
    await refreshLocalState(isActive);
    // The parent scan already tracks this work through completion. Registering
    // another global producer would outlive the catalog that owns the scan.
    if (isActive()) await refreshVerdicts(isActive);
  };
  return {
    refreshServer(fetchImpl?: typeof fetch): Promise<void> {
      const revision = ++serverRevision;
      return disposed ? Promise.resolve() : refreshServer(fetchImpl, () => !disposed && revision === serverRevision);
    },
    refresh(): Promise<void> { return disposed ? Promise.resolve() : hostSave.run(scan); },
    schedule(delay: number, onError: (error: unknown) => void): void {
      if (!disposed) hostSave.schedule(scan, delay, onError);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      hostSave.forget(scan);
    },
  };
}

async function refreshLocalState(isActive: () => boolean): Promise<void> {
  const { io } = await uiState();
  if (!isActive()) return;
  const registry = (await io.read()).workspaces;
  if (!isActive()) return;
  const onDisk: string[] = [];
  const empty: string[] = [];
  let changed = new Set(registry.filter((e) => e.hasChanges).map((e) => e.id));
  try {
    await initFileSystem();
    const { fs } = await import('../filesystem');
    if (!isActive()) return;
    // shells write the offline setting into the pod fs — adopt it (chip flips live)
    try {
      const { readPodSettings } = await import('@artipod/core/oci');
      const value = (await readPodSettings(fs as unknown as Parameters<typeof readPodSettings>[0])).offline === true;
      if (!isActive()) return;
      keys().reconcileOffline(value);
    } catch {
      // fs not initialized yet — the boot mirror stands
    }
    // Local heads for the digest-verified synced badge. Their logical JSON
    // records and names are protected by the encrypted root.
    try {
      const { OciStore } = await import('@artipod/core/oci');
      if (!isActive()) return;
      const store = new OciStore(fs as unknown as ConstructorParameters<typeof OciStore>[0]);
      await store.init();
      const localHeads = Object.fromEntries((await store.listRefs()).map((r) => [r.ref, r.manifestDigest]));
      if (!isActive()) return;
      catalogStore.setState({ localHeads });
    } catch {
      // no local store yet
    }
    const dirs = (await fs.promises.readdir('/work').catch(() => [])) as string[];
    const live = await liveWorkspaceIds();
    if (!isActive()) return;
    for (const id of dirs) {
      const entries = (await fs.promises.readdir(`/work/${id}`).catch(() => null)) as string[] | null;
      if (!isActive()) return;
      if (entries && entries.length === 0 && live && !live.has(id)) {
        // A listing may become stale before the registry mutex is available.
        // Filter the view while preserving both the directory and its entry.
        empty.push(id);
      } else {
        onDisk.push(id);
      }
    }
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
        if (!isActive()) return;
        if (id.includes(':') || !liveNow || liveNow.has(id)) continue; // refs and open tabs are not candidates
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
        if (!isActive()) return;
        if (localFiles.size === 0) continue;
        // tar mtimes are second-granular — compare with 2s tolerance
        const matches = manifests.some(
          (files) =>
            files.size === localFiles.size &&
            Array.from(localFiles.entries()).every(([p, t]) => files.has(p) && Math.abs((files.get(p) ?? 0) - t) < 2000),
        );
        if (matches) {
          // Matching a cached manifest filters this view; it cannot authorize
          // deleting local bytes or acknowledging a workspace's saved state.
          onDisk.splice(onDisk.indexOf(id), 1);
        }
      }
    } catch {
      // offline or no server — reconciliation is best-effort
    }
    // Inspect logical protected uppers on either backend. Legacy uppers stay
    // readable until their per-ref migration completes.
    {
      changed = new Set<string>();
      const modeById = new Map(registry.map((e) => [e.id, e.mode]));
      for (const e of registry) {
        if (e.kind !== 'pod') continue;
        if (modeById.get(e.id) === 'rw') continue; // autoPush keeps rw synced
        const legacy = encodeURIComponent(e.id);
        const hashed = await upperDirName(e.id);
        const candidates = [workspaceUpperPaths(e.id).directory, `/.artipod/uppers/${legacy}`, `/.artipod/uppers/${hashed}`];
        const directory = (await Promise.all(candidates.map(async path => await fs.promises.exists(path) ? path : null))).find(Boolean);
        if (!directory) continue;
        const entries = await fs.promises.readdir(directory);
        if (entries.length === 0) continue;
        if (directory !== candidates[2] || e.hasChanges) changed.add(e.id);
      }
    }
  } catch {
    // no /work yet (or init failed) — registry alone
  }
  if (!isActive()) return;
  catalogStore.setState({ changedRefs: Array.from(changed) });
  // Snapshot: registry entries filtered to what actually exists, plus
  // unregistered on-disk blanks.
  const current = (await io.read()).workspaces;
  if (!isActive()) return;
  const byId = new Map<string, LocalEntry>(
    current.filter((e) => !empty.includes(e.id) && (e.kind === 'pod' || onDisk.includes(e.id))).map((e) => [e.id, e]),
  );
  for (const id of onDisk) {
    if (!byId.has(id)) byId.set(id, { id, kind: 'blank', lastOpened: 0 });
  }
  const actor = (await io.read()).actor ?? null;
  if (!isActive()) return;
  registryStore.setState({
    entries: Array.from(byId.values()).sort((a, b) => b.lastOpened - a.lastOpened),
    actor,
  });
}

/** Publish observational verdicts as part of the caller's tracked refresh. */
export async function refreshVerdicts(isActive: () => boolean = () => true): Promise<void> {
  if (!isActive()) return;
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
    if (!isActive()) return;
    catalogStore.setState({ verdicts: Object.fromEntries(verdicts) as Record<string, SyncVerdict> });
  } catch {
    // fs not ready — flags stand
  }
}
