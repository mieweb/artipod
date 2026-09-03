'use client';

/**
 * Routing (?artipod=<ref-or-id>&mode=rw|cow|ro, static-export friendly):
 *   /                   → the catalog
 *   /?artipod=<id>      → workspace (U3 — stub until then)
 * Until U5 removes reloads, navigation between routes is a full page load
 * on purpose: a workspace boots its FS once per page.
 */
import { useEffect, useState } from 'react';
import Catalog from '@/components/Catalog';
import Workspace from '@/components/Workspace';
import { actorId, keys, parseRoute, type Route } from '@/lib/boot';

export default function Page() {
  // undefined = parsing; null = catalog; Route = workspace
  const [route, setRoute] = useState<Route | null | undefined>(undefined);

  useEffect(() => {
    const parsed = parseRoute(window.location.search);
    void (async () => {
      // Broker serves gate blob access behind key leases: probe, login, and
      // patch /api/pods fetches BEFORE any view starts syncing.
      await keys().install(actorId).catch(() => {});
      setRoute(parsed);
    })();
  }, []);

  if (route === undefined) return <main className="h-[var(--app-height)] bg-black" />;
  if (route === null) return <Catalog actorId={actorId} />;
  return <Workspace route={route} />;
}
