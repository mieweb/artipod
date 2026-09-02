'use client';

/**
 * Forced-offline toggle (demo): one click makes every same-origin /api
 * request fail like a dead network — auto-push queues locally, lease
 * renewals fail, the whole offline story becomes testable without touching
 * the server. Client-side only; flip it back and the next edit re-syncs.
 */
import { useSyncExternalStore } from 'react';
import { Cloud, CloudOff } from 'lucide-react';
import { isForcedOffline, setForcedOffline, onBrokerChange } from '@/lib/keys';

export default function OfflineToggle() {
  const offline = useSyncExternalStore(onBrokerChange, isForcedOffline, isForcedOffline);
  return (
    <button
      onClick={() => setForcedOffline(!offline)}
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
