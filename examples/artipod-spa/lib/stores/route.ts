/**
 * Client-side routing (spa-ui-plan U5): catalog ⇄ workspace transitions
 * without page reloads. URLs stay link-compatible (?artipod=<ref>&mode=);
 * pushState + popstate keep history honest. Consumers render from the
 * snapshot; PodSessionService lifecycles ride the route change.
 */
import { createStore } from 'zustand/vanilla';
import { parseRoute, workspaceUrl, type OpenMode, type Route } from '../boot';

export interface RouteSnapshot {
  /** undefined = parsing (first paint); null = catalog; Route = workspace. */
  route: Route | null | undefined;
}

export const routeStore = createStore<RouteSnapshot>()(() => ({ route: undefined }));

let installed = false;

/** Parse the current URL into the store; install the popstate listener once. */
export function initRouting(): void {
  routeStore.setState({ route: parseRoute(window.location.search) });
  if (installed) return;
  installed = true;
  window.addEventListener('popstate', () => {
    routeStore.setState({ route: parseRoute(window.location.search) });
  });
}

/** Navigate in-app: catalog (no args) or a workspace. */
export function navigateTo(id?: string, mode: OpenMode = 'rw', extraQuery = ''): void {
  const url = id ? `${workspaceUrl(id, mode)}${extraQuery}` : '/';
  window.history.pushState(null, '', url);
  routeStore.setState({ route: parseRoute(new URL(url, window.location.origin).search) });
}

/** anchor onClick handler: SPA-navigate on plain left clicks, let modified clicks open tabs. */
export function navClick(e: { preventDefault(): void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button?: number }, id?: string, mode: OpenMode = 'rw', extraQuery = ''): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || (e.button ?? 0) !== 0) return; // new-tab affordances stay
  e.preventDefault();
  navigateTo(id, mode, extraQuery);
}
