'use client';

/**
 * Forced-offline toggle, on settingsStore: one click makes every same-origin
 * /api request fail like a dead network — auto-push queues locally, lease
 * renewals fail, the offline story becomes testable without touching the
 * server. Source of truth is the pod setting (`artipod offline on|off`).
 */
import { useStore } from 'zustand';
import { Cloud, CloudOff } from 'lucide-react';
import { settingsStore } from '@/lib/stores/settings';
import { keys } from '@/lib/boot';

export default function OfflineToggle() {
  const offline = useStore(settingsStore, (s) => s.forcedOffline);
  return (
    <button
      onClick={() => keys().setForcedOffline(!offline)}
      className={
        offline
          ? 'inline-flex items-center gap-1 rounded bg-amber-900/60 px-1.5 py-0.5 text-[11px] text-amber-200 hover:bg-amber-800/60'
          : 'inline-flex items-center gap-1 rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-500 hover:text-gray-300'
      }
      title={
        offline
          ? 'FORCED OFFLINE — every /api request fails like a dead network; edits stay in the local (encrypted) upper and lease renewals fail. Click to reconnect.'
          : 'simulate going offline: block all syncing and key traffic from this tab (the server keeps running)'
      }
    >
      {offline ? <CloudOff size={11} /> : <Cloud size={11} />} {offline ? 'offline (forced)' : 'online'}
    </button>
  );
}
