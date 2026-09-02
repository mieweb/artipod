'use client';

/**
 * Update/sync status for an auto-pushing (rw) workspace, driven by pod
 * events: fs:changed → "pending", sync:push ok → "synced HH:MM",
 * sync:push !ok → "push failed" (the offline case — retries on the next
 * change). Honest about the model: per-file LWW anti-entropy, not CRDTs.
 */
import { useEffect, useState } from 'react';
import { CloudOff, RefreshCw, Check } from 'lucide-react';
import type { PodEvents } from '@artipod/core/host';

type SyncState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'synced'; at: number; layers: number }
  | { kind: 'failed'; at: number; error?: string };

const timeShort = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export default function SyncStatus({ events, active }: { events: PodEvents; active: boolean }) {
  const [state, setState] = useState<SyncState>({ kind: 'idle' });

  useEffect(() => {
    if (!active) return;
    const offChanged = events.on('fs:changed', () => {
      setState((s) => (s.kind === 'failed' ? s : { kind: 'pending' }));
    });
    const offPush = events.on('sync:push', (e) => {
      setState(e.ok ? { kind: 'synced', at: Date.now(), layers: e.layers } : { kind: 'failed', at: Date.now(), error: e.error });
    });
    return () => {
      offChanged();
      offPush();
    };
  }, [events, active]);

  if (!active || state.kind === 'idle') return null;
  if (state.kind === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-400" title="local changes queued — auto-push runs after a quiet moment">
        <RefreshCw size={11} className="animate-spin" /> syncing…
      </span>
    );
  }
  if (state.kind === 'synced') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-400"
        title={`last push ${timeShort(state.at)} — head carries ${state.layers} overlay layer(s); per-file last-write-wins with merge-on-push (no CRDTs — one writer per file path)`}
      >
        <Check size={11} className="text-emerald-400" /> synced {timeShort(state.at)}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-amber-900/60 px-1.5 py-0.5 text-[11px] text-amber-200"
      title={`push failed ${timeShort(state.at)}${state.error ? ` — ${state.error}` : ''}; changes stay safe in the local (encrypted) upper and retry on the next edit`}
    >
      <CloudOff size={11} /> offline — changes local
    </span>
  );
}
