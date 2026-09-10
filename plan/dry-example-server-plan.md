# DRY the embed story + example server (plan)

Goal: someone hosting artipod inside their own **Next.js / Hono / Express / Fastify**
app should need only a few lines — and our own example must be that few lines.
Today `createArtipodApp` (src/server/app.ts) already is the one-handler embed
surface, but (a) there is no exported node req/res adapter for Express-style
frameworks, and (b) `examples/artipod-sync` predates `createArtipodApp` and
still hand-wires four routes plus a stale fork of `PublishMap`.

Read before starting:

- `src/server/app.ts` — `createArtipodApp` (the composed fetch handler)
- `src/server/node.ts` — `serveApp` + the private `toRequest`/`dispatch` bridge
- `src/server/serve.ts` (~line 230–300) — how the CLI wires policy into the app
- `src/server/publish-map.ts` — core `PublishMap` / `withinRoots`
- `examples/artipod-sync/app/api/**` and `examples/artipod-sync/lib/publish-map.ts` — the duplication to delete
- Root `.github/copilot-instructions.md` — lint/build/test before every commit

Ground rules:

- No new dependencies (core or example). No behavior/URL changes visible to the demo UI.
- Each phase is one commit; run `npm run lint && npm run build && npm run test` before each.
- Do NOT release/publish; version bumps are handled separately.

---

## E1 — export a node adapter: `toNodeHandler(app)`

The bridge already exists inside `src/server/node.ts` (`toRequest` + `dispatch`)
but only `serveApp` (a whole standalone `http.Server`) is exported. Express and
plain `node:http` users need the bridge itself.

1. In `src/server/node.ts`, add and export:

   ```ts
   /** Node req/res adapter: mount an ArtipodApp in Express or node:http. */
   export function toNodeHandler(app: ArtipodApp): (req: IncomingMessage, res: ServerResponse) => void {
     return (req, res) => {
       void dispatch(app, req, res, req.headers.host ?? 'localhost');
     };
   }
   ```

   Then make `serveApp` use it (`createServer(toNodeHandler(app))`) so there is
   exactly one dispatch path. Do not change `dispatch`/`toRequest` semantics
   (streaming via `Readable.fromWeb`, HEAD sends no body, errors → 500 JSON).

2. Export from `src/server/index.ts` next to `serveApp`.

3. Tests in `src/server/node.test.ts` (use plain `node:http`, no new deps):
   - `http.createServer(toNodeHandler(app))` serves a GET (status, headers, body).
   - A PUT with a body reaches the app intact (streamed request body).
   - HEAD returns headers but no body.
   - An app that throws yields a 500 JSON response, socket not left hanging.

4. Docs: add an “Embedding in your own server” section to `docs/serve.md` with
   these exact snippets (verify each compiles mentally against our exports):

   ```ts
   // shared setup (node)
   import { nodePodFs } from '@artipod/core';
   import { OciLayoutPodStore } from '@artipod/core/manager';
   import { createArtipodApp, toNodeHandler } from '@artipod/core/server';

   const store = new OciLayoutPodStore(nodePodFs(), './my-store');
   await store.init();
   const artipod = createArtipodApp({ store });
   ```

   ```ts
   // Express
   app.use(toNodeHandler(artipod)); // mount at root — see caveat below
   ```

   ```ts
   // Hono (or any fetch-native host: Bun.serve, Deno.serve)
   app.all('*', (c) => artipod(c.req.raw));
   ```

   ```ts
   // Next.js App Router: app/api/[...path]/route.ts (and app/v2/[[...path]]/route.ts)
   export const GET = (req: Request) => artipod(req);  // repeat for HEAD/POST/PUT/DELETE/OPTIONS
   ```

   Caveats to state explicitly:
   - `createArtipodApp` routes on the **root** pathname (`/api/...`, `/v2/...`);
     mounting under a prefix is not supported — mount at `/`.
   - Fastify parses bodies before handlers; either run `serveApp` beside it or
     register `toNodeHandler` via `@fastify/middie`. Don't promise more.

Acceptance: new export + tests green; `docs/serve.md` section exists;
`browser-guard.test.ts` still passes (node.ts is already server-only).

---

## E2 — collapse the example's API routes onto `createArtipodApp`

This is the “demo catch-all refactor” already earmarked in
artipod-serv-plan.md S2. The demo UI calls the same URLs afterwards — this is a
server-side-only refactor.

1. New `examples/artipod-sync/lib/artipod-app.ts` — a lazy singleton, mirroring
   the existing `lib/pods-store.ts` pattern:

   ```ts
   import { PodSessionHost } from '@artipod/core/manager';
   import { allowedHosts, bearerAuth, createArtipodApp, type ArtipodApp } from '@artipod/core/server';
   import { getPodStore } from './pods-store';
   import { getPublishMap, publishRoots } from './publish-map';
   ```

   Options to pass (all current behavior, nothing new):
   - `store` from `getPodStore()`
   - `relay: { allowedHosts: (process.env.ARTIPOD_OCI_ALLOWED_HOSTS ?? '').split(',') }`
   - `gitAllowlist: allowedHosts(process.env.GIT_PROXY_ALLOWED_HOSTS)`
   - `exec`: `PodSessionHost` with the same numbers as today
     (`ttlMs: 15*60_000, maxSessions: 50, execTimeoutMs: 30_000, maxFsBytes: 256*1024*1024`)
     plus `auth: bearerAuth(() => process.env.EXEC_API_TOKEN)`
   - `onRefPut`: the materialize-back glue currently inlined in
     `app/api/pods/[...path]/route.ts`, rewritten on core `PublishMap` (see E3)
   - `ui: false` (Next serves the UI), no `fallback` (unknown `/api/*` → 404 JSON, same as today)

2. Replace four routes with one catch-all
   `examples/artipod-sync/app/api/[...path]/route.ts`:

   ```ts
   import { getArtipodApp } from '@/lib/artipod-app';
   export const dynamic = 'force-dynamic';
   const h = async (req: Request) => (await getArtipodApp())(req);
   export { h as GET, h as HEAD, h as POST, h as PUT, h as DELETE, h as OPTIONS };
   ```

   Delete:
   - `app/api/pods/[...path]/route.ts`
   - `app/api/oci/[...path]/route.ts`
   - `app/api/git/[...path]/route.ts`
   - `app/api/exec/route.ts`

   Keep as-is (static segments win over the catch-all in Next):
   - `app/api/pods/publish/route.ts` (E3 trims its imports)
   - `app/api/fake-llm/**`

3. Set `export const runtime = 'nodejs'` on the catch-all (the git proxy and
   exec host need node).

Acceptance:
- `cd examples/artipod-sync && npm run build` passes.
- Manual smoke against `npm run dev`: pull a pod in the browser demo
  (exercises `/api/oci`), open the terminal (`/api/exec` if EXEC enabled),
  `git clone` in the workspace shell (`/api/git`), push/pull a ref (`/api/pods`).
- Unknown route `/api/nope` returns `{"error":"not found"}` 404.

---

## E3 — delete the example's `PublishMap` fork

Core's `src/server/publish-map.ts` header says it was “ported from
artipod-sync's lib/publish-map.ts, parameterized”. Finish the move: the example
consumes core; only env parsing stays app-side.

1. Rewrite `examples/artipod-sync/lib/publish-map.ts` to ~15 lines:

   ```ts
   import { join } from 'node:path';
   import { PublishMap, withinRoots } from '@artipod/core/server';

   export const publishRoots = (): string[] =>
     (process.env.ARTIPOD_PUBLISH_ROOTS ?? '').split(',').map((r) => r.trim()).filter(Boolean);

   let map: PublishMap | null = null;
   export function getPublishMap(): PublishMap {
     if (!map) map = new PublishMap(join(process.env.ARTIPOD_STORE_DIR ?? '.artipod-store', 'publish-map.json'));
     return map;
   }
   ```

2. Update `app/api/pods/publish/route.ts`:
   `withinPublishRoots(dir)` → `withinRoots(dir, publishRoots())`;
   `recordPublishDir(ref, dir)` → `getPublishMap().record(ref, dir)`.
   Everything else (REF_RE validation, 403 hint, publishDirectory call) stays.

3. The `onRefPut` in `lib/artipod-app.ts` (E2) uses the same pieces —
   compare with `src/server/serve.ts` `onRefPut` and keep the same shape:
   look up `dirFor(ref)`, re-check `withinRoots` (the map is data, not
   authority), `materializeRef`, warn-don't-throw.

Acceptance: on-disk format unchanged (`publish-map.json` beside the store —
an existing map from before the refactor still works); publish → edit in
browser → push → file appears in the server folder, same as today.

---

## E4 — wrap up

1. `examples/artipod-sync/README.md`: point the “server routes” section at the
   single catch-all + `createArtipodApp`, and link `docs/serve.md#embedding`.
2. Check `examples/artipod-sync` line count actually dropped
   (`find app/api lib -name '*.ts' | xargs wc -l` — API+glue was ~200 lines;
   target is roughly 60).
3. CHANGELOG `Unreleased`: `toNodeHandler` export + example refactor note.

---

## Gotchas (read these BEFORE debugging weirdness)

- **Stale core copy in the example.** `@artipod/core: file:../..` installs as a
  COPY (`.npmrc install-links=true`, load-bearing — do not remove). After any
  core change: root `npm run build`, then in `examples/artipod-sync`
  `rm -rf node_modules/@artipod/core && npm install`. A stale copy will make
  E1's new export “not exist”.
- **Build before test** at the repo root: CLI tests spawn `dist/cli.js`.
- **Static export script**: `npm run export:static` stashes `app/api` wholesale;
  the new catch-all lives under `app/api` so it keeps working. If you add any
  route outside `app/api` (e.g. an optional `/v2` surface), the stash list in
  the export script must grow too — otherwise skip `/v2`; it is NOT required
  by this plan.
- **Next route precedence**: static segments (`api/pods/publish`, `api/fake-llm`)
  win over `api/[...path]` — no ordering work needed, but don't rename them.
- **mount.spec.ts** has a known flaky timeout under full-suite load — rerun
  before blaming your change.
- Do not touch `attic/`, `dist-ui/`, or the deployed sample-site config
  (`examples/artipod-sync/AGENTS.md` covers the artipod-bash box — this plan
  requires no deployment).

## Out of scope (explicitly)

- Adding the `/v2` registry surface to the Next example.
- A `createServeDefaults()` helper promoting serve's seal/ref-log policy glue
  into core (noted as a future tension; leave `serve.ts` alone).
- First-class Fastify plugin.
- Any release/publish steps.
