'use client';

/**
 * Update/sync status for an auto-pushing (rw) workspace, on workspaceStore
 * (PodSessionService bridges pod events into the snapshot). Honest about
 * the model: per-file LWW anti-entropy, not CRDTs.
 */
import { useStore } from 'zustand';
import { CloudOff, RefreshCw, Check } from 'lucide-react';
import { workspaceStore } from '@/lib/stores/workspace';

const timeShort = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export default function SyncStatus() {
  const active = useStore(workspaceStore, (s) => s.syncActive);
  const state = useStore(workspaceStore, (s) => s.sync);
  if (!active || state.kind === 'idle') return null;
  if (state.kind === 'pending') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-400"
        title="local changes queued — auto-push runs after a quiet moment"
      >
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
