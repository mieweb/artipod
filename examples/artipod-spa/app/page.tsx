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
import { actorId, keys, parseRoute, type Route } from '@/lib/boot';

const CORE_VERSION = process.env.NEXT_PUBLIC_ARTIPOD_VERSION ?? 'dev';

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
  return (
    <main className="mx-auto max-w-lg p-8 font-mono text-sm">
      <h1 className="mb-2 text-lg font-bold">workspace: {route.id}</h1>
      <p className="opacity-60">
        the workspace shell lands in U3 (spa-ui-plan) — mode {route.mode}, core {CORE_VERSION}
      </p>
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/" className="underline">← catalog</a>
    </main>
  );
}
