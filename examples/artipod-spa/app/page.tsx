'use client';

/**
 * U0 placeholder: proves the whole pipeline — zustand vanilla store bound via
 * useStore, live refs from `artipod serve` (proxied in dev, same-origin when
 * served as the static UI), and a real client-side ZenFS touch so the
 * struct-minify assertion is exercised rather than vacuous.
 */
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { catalogStore } from '@/lib/stores/catalog';

const CORE_VERSION = process.env.NEXT_PUBLIC_ARTIPOD_VERSION ?? 'dev';

function useZenfsProbe(): string {
  const [probe, setProbe] = useState('booting…');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { fs } = await import('@zenfs/core');
        await fs.promises.writeFile('/u0-probe', 'spa');
        const back = await fs.promises.readFile('/u0-probe', 'utf8');
        if (!cancelled) setProbe(back === 'spa' ? 'zenfs ok' : 'zenfs mismatch');
      } catch (err) {
        if (!cancelled) setProbe(`zenfs failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return probe;
}

export default function Page() {
  const { status, refs, error } = useStore(catalogStore);
  const probe = useZenfsProbe();

  useEffect(() => {
    void catalogStore.getState().refreshServer();
  }, []);

  return (
    <main className="mx-auto max-w-2xl p-8 font-mono text-sm">
      <h1 className="mb-1 text-lg font-bold">artipod — SPA (U0 placeholder)</h1>
      <p className="mb-6 opacity-60">
        core {CORE_VERSION} · {probe}
      </p>
      <h2 className="mb-2 font-semibold">server refs ({status})</h2>
      {status === 'error' && <p className="text-red-400">refs failed: {error}</p>}
      <ul data-testid="refs">
        {refs.map((r) => (
          <li key={r.ref} className="flex gap-3 py-0.5">
            <span>{r.ref}</span>
            <span className="opacity-50">{r.manifestDigest.slice(0, 19)}…</span>
            {r.encrypted && <span title="content encrypted at rest">🔒</span>}
          </li>
        ))}
      </ul>
    </main>
  );
}
