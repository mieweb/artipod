/**
 * CatalogService — sync verdicts (spa-ui-plan U1, extracted from the old
 * app's two interdependent page effects). Ancestry beats recorded flags:
 * a navigation-aborted push leaves a stale 'failed' flag even though the
 * ref landed (or vice versa) — the parents DAG in the local store is the
 * truth. `computeVerdicts` is pure over an injected walker; `boundAncestry`
 * builds the real one (local OciStore, broker-key decrypt for the DAG walk).
 */

export type SyncVerdict = 'synced' | 'ahead' | 'behind';

export interface VerdictRef {
  ref: string;
  manifestDigest: string;
}

export interface VerdictInputs {
  serverRefs: VerdictRef[];
  /** ref → local head digest (absent = nothing local to compare). */
  localHeads: Map<string, string>;
  /** True when `ancestor` is an ancestor of (or equal to) `descendant` in the parents DAG. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
}

/**
 * synced  = local head IS the server head (digest equality — a verified claim)
 * ahead   = server head is an ancestor of the local head (unpushed local work)
 * behind  = anything else (server moved past us / diverged)
 * no entry = no local head, or the walk failed (locked store, missing blobs) —
 *            the recorded registry flag stands in that case.
 */
export async function computeVerdicts(inputs: VerdictInputs): Promise<Map<string, SyncVerdict>> {
  const verdicts = new Map<string, SyncVerdict>();
  for (const r of inputs.serverRefs) {
    const localHead = inputs.localHeads.get(r.ref);
    if (!localHead || !r.manifestDigest) continue;
    if (localHead === r.manifestDigest) {
      verdicts.set(r.ref, 'synced');
      continue;
    }
    try {
      verdicts.set(r.ref, (await inputs.isAncestor(r.manifestDigest, localHead)) ? 'ahead' : 'behind');
    } catch {
      // locked store or missing blobs — no verdict, the flag stands
    }
  }
  return verdicts;
}

/** Registry heal: which entries' stale `unsynced` flags the verdicts disprove. */
export function healUnsynced(
  entries: { id: string; unsynced?: boolean }[],
  verdicts: Map<string, SyncVerdict>,
): string[] {
  return entries.filter((e) => e.unsynced && verdicts.get(e.id) === 'synced').map((e) => e.id);
}

/** The real walker: local OciStore over the app fs, manifests decrypted with the broker key when present. */
export async function boundAncestry(
  fs: unknown,
  getKey: () => CryptoKey | null,
): Promise<VerdictInputs['isAncestor']> {
  const { OciStore } = await import('@artipod/core/oci');
  const { isAncestor } = await import('@artipod/core/manager');
  const store = new OciStore(fs as ConstructorParameters<typeof OciStore>[0]);
  await store.init();
  const key = getKey();
  if (key) await store.enableEncryption(() => key); // manifests decrypt for the DAG walk
  return (ancestor, descendant) => isAncestor(store, ancestor as never, descendant as never);
}
