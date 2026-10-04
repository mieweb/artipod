'use client';

/**
 * Routing (?artipod=<ref-or-id>&mode=rw|cow|ro, static-export friendly).
 * U5: transitions are CLIENT-SIDE — no reloads. The workspace is keyed by
 * route so switching pods unmounts the old session (PodSessionService.close
 * flushes + disposes) and boots the next in the same page.
 */
import { useEffect } from 'react';
import { useStore } from 'zustand';
import Catalog from '@/components/Catalog';
import Workspace from '@/components/Workspace';
import { actorId, keys } from '@/lib/boot';
import { initRouting, routeStore } from '@/lib/stores/route';

export default function Page() {
  const route = useStore(routeStore, (s) => s.route);

  useEffect(() => {
    void (async () => {
      // Broker serves gate blob access behind key leases: probe, login, and
      // patch /api/pods fetches BEFORE any view starts syncing.
      await keys().install(actorId).catch(() => {});
      initRouting();
    })();
  }, []);

  if (route === undefined) return <main className="h-[var(--app-height)] bg-black" />;
  if (route === null) return <Catalog actorId={actorId} />;
  return <Workspace key={`${route.id}:${route.mode}`} route={route} />;
}
