# artipod SPA UI plan — zustand state, @mieweb/ui components, serve-only backend

**Status**: Living implementation plan — the implementer updates this file as work proceeds (same rules as `artipod-layer-plan.md` §0)
**Date**: 2026-09-02
**Owner / Implementer**: horner (phase gates self-reviewed)
**Follows**: `artipod-serv-plan.md` (S0–S5.5 shipped: broker keys, encrypted stores/uppers, offline mode) and `sync-demo-plan.md`. The demo (`examples/artipod-sync`) was "quick and dirty" and its state management has decayed into four uncoordinated layers: React `useState`/`useEffect` chains in a ~1,800-line `page.tsx`, module-singleton state in `lib/keys.ts` with a hand-rolled subscribe/notify, an fs-resident registry (`/.artipod/ui-state.json`) with raw-OPFS IO, and localStorage mirrors. Every feature added this week (badges, verdicts, offline, lease persistence) made it worse. This plan replaces the UI wholesale.

## 0. How to work this plan

Working rules, commit conventions, phase-gate ritual (`docs(plan): spa phase UN gate`), verification rule (paste command + result into the worklog), and the deviation rule are **identical to `artipod-layer-plan.md` §0**. Extra rules for this plan:

- The OLD app (`examples/artipod-sync`) stays green and remains the shipped `dist-ui` until U7 cutover. Do not refactor it except for extraction moves it explicitly signs up for — and the UE embed refactor (E2/E3 below), which it also signs up for.
- Every phase ends with the full core gate (`npm run lint && npm run build && npx tsc --noEmit && npm run test`) **plus** the new app's own `lint`/`typecheck`/`test`/`build`.
- Browser verification happens against a real `artipod serve --encrypt` (the broker is the hard case); drive the page via `window.__artipod`-style escape hatches, not Playwright keyboard events (xterm swallows them — see repo memory).
- @mieweb/ui conventions apply (repo-external, learned elsewhere and binding here): style with `--mieweb-*` design tokens, never generic shadcn vars; verify dark mode before any gate that touches components.
- ZenFS structs vs minifiers: any change to the build pipeline re-runs the struct-minify assertion (`export-static.mjs` marker) before its gate.

### Ask-first list (owner sign-off required)

- Anything touching the deployed sample site (`artipod-bash`): the U7 redeploy replaces `next start` with `artipod serve` — new systemd unit, new runbook.
- Retiring/deleting `examples/artipod-sync` (U7; history stays in git, but it is the only reference implementation until parity is proven).
- Adopting yorm beyond the U6 spike (new prod dependencies, a WS transport on serve, and a Phase-7-adjacent architecture decision).
- Publishing any core release this plan requires (e.g. WS upgrade hooks in `serveApp`, the client-lib packaging if it becomes a new npm package).
- Ozwell integration specifics (entry point, credentials/API keys) — owner supplies at U4 start.

### Phase tracker (keep current)

| Phase | Branch | Status | PR |
|---|---|---|---|
| U0 — scaffold + build pipeline parity | main | **done** | |
| UE — DRY the embed story (dry-example-server-plan E1–E4) | main | todo | |
| U1 — services + zustand stores (no React) | main | todo | |
| U2 — catalog on stores + @mieweb/ui | main | todo | |
| U3 — workspace shell + pod session service | main | todo | |
| U4 — panels: terminal, tree, editor, agent | main | todo | |
| U5 — true SPA navigation (no reloads) | main | todo | |
| U6 — yorm spike: collaborative editor (gated) | main | todo | |
| U7 — cutover: dist-ui swap, retire old app, redeploy | main | todo | |

## 1. Goal — the north star

> One `examples/artipod-spa` app: a static-exported single-page client whose ONLY backend is `artipod serve`. All state lives in typed zustand stores fed by framework-agnostic services; components are thin @mieweb/ui-styled views; opening, closing, and switching workspaces never reloads the page; and every badge/verdict/lease behavior shipped this week works identically — provable by replaying this week's browser verifications against the new UI.

### Deliverables (owner clarification, 2026-09-02)

The rewrite is not just a new demo — it factors the monolith into four artifacts:

| # | Deliverable | Home |
|---|---|---|
| D1 | **Sample app** demonstrating and TESTING synchronous editing: file nav, **kerebron** editor, **Ozwell** agent (replacing Monaco + the current AgentPanel) | `examples/artipod-spa` |
| D2 | **Client lib** for in-browser AND in-node-isolate sync + key management — the services layer, packaged; scheduling made introspectable and surfaced as an **`artipod ps`** shell verb | packaging decided at U1 gate: `@artipod/core` subpath (e.g. `/client`) vs new `@artipod/client` package |
| D3 | **Terminal shell component** for artipod-shell: embeddable xterm wrapper with a narrow attach/dispose contract | extracted at U4 |
| D4 | **Serve mode = just the artipod API** — no UI logic server-side | already ratified (P2); dist-ui remains an optional static bundle it can host |

Success = the U7 parity checklist (all §5 behaviors) green against `artipod serve --encrypt`, `npm run build:ui` producing the new app, all four deliverables shipped, and `page.tsx`-the-monolith deleted.

## 2. Decisions (ratified 2026-09-02, owner-answered — do not relitigate)

| # | Decision |
|---|---|
| P1 | **Framework: Next static export, SPA-style.** One client-only page (`'use client'`, `output: 'export'`), no `app/api`, no prerendered data. Keeps the known-good export pipeline (struct-minify plugin, buildinfo, `artipod import` flow). Vite was considered and declined — re-verifying the ZenFS-structs-vs-minifier landmine on a second toolchain buys nothing. |
| P2 | **Backend: `artipod serve` only.** The demo's API routes (`app/api/pods|oci|git|exec|publish`) are NOT ported — serve does all of it natively now (keys, encrypt, seal, publish, write-back). Dev loop: `artipod serve --encrypt --publish …` on 2784 + `next dev` with rewrites proxying `/api/*` and `/v2/*` to it. Milestone UE proves the coverage first (the old app's routes collapse onto `createArtipodApp` with real UI traffic); U7's deletion finishes the job. |
| P3 | **Migration: parallel app, swap at parity.** New app at `examples/artipod-spa`; artipod-sync keeps shipping as `dist-ui` until U7. No in-place refactor of the old monolith. |
| P4 | **State: zustand, with a services layer.** Vanilla (`createStore`) stores so services and tests need no React; React binds via `useStore`. Stores hold SNAPSHOTS (serializable state); live objects — pods, sandboxes, CryptoKeys, Y.Docs — live in services and are looked up by id. **Never put key material or pod instances in a persisted store.** |
| P5 | **Components: @mieweb/ui**, tokens and all. Tailwind stays for layout only; anything themed goes through `--mieweb-*` vars. lucide icons stay. |
| P6 | **Durable state keeps its current homes** — this plan fixes the ACCESS layer, not the storage: registry stays in `/.artipod/ui-state.json` (cross-tab raw-OPFS IO + Web-Lock), offline stays in `/.artipod/oci/settings.json` (the `artipod offline` contract), the wrapped session + device key stay in IndexedDB, broker-meta/offline boot mirrors stay in localStorage. Stores are write-through caches over these. |
| P7 | **yorm is a spike, not a dependency** (owner: "consider using yorm for the multiple editor"). U6 evaluates `@yorm/*` 0.1.0 for concurrent editing of one file (the layer-plan Phase 7 "Yjs-in-a-file" slot) and for the multi-tab problem. Adoption is a separate ask-first decision with its own transport prerequisite (serve has no WebSocket today). |
| P8 | **Editor = kerebron, not a Monaco port** (added 2026-09-02, owner clarification). The sample app is explicitly a test bed for synchronous editing, and kerebron ships `extension-yjs` natively — which reframes U6. Carries known integration constraints: `@kerebron/{editor,editor-kits,wasm}` peers (current, ≥0.8.6), wasm assets served under static export, CoreEditor mounted in a disposable child div, never CSS-transition the editor's width. |
| P9 | **Agent = Ozwell** (added 2026-09-02, owner clarification), replacing the current AgentPanel — "instead of what is there". Integration entry point (embed/SDK/API) pinned with the owner before U4 starts; the old panel's pod-tool contract is the spec for what the agent can touch. |
| P10 | **The services layer is a shippable client lib** (added 2026-09-02, owner clarification): sync + key management usable from the browser AND from node isolates — no DOM/window assumptions outside injected adapters. Its task scheduling (key renewal, push retry, verdict refresh) is introspectable and exposed in the pod shell as `artipod ps`. |

## 2.5 Temporary vendor submodules

The repo has no submodules today (the demo's only local dep is `@artipod/core` via `file:../..`). The SPA pulls in three-plus external mieweb codebases that are young enough to need patching mid-integration, so we vendor them as git submodules under `vendor/` **with written exit criteria** — a vendor entry without a removal condition is a fork, not a convenience.

| Submodule | Needed from | Why vendored (not just npm) | Removed when |
|---|---|---|---|
| `vendor/ui` → github.com/mieweb/ui | U0 | Token pass + component gaps will surface while building catalog/workspace chrome; the kerebron.css workarounds live here; known pain: apps install *copies* of published @mieweb/ui, so editing source does nothing without a link — a submodule + `file:` dep makes iteration sane | a pinned published `@mieweb/ui` release covers every component/token/kerebron fix we needed |
| `vendor/kerebron` → kerebron source | U4 (maybe — try published peers first) | 0.8.x has known menu-plugin and mount-lifecycle bugs; static-export + wasm-asset integration may need patches faster than upstream releases | published `@kerebron/*` release works under our static export with only CSS-level workarounds (which live in @mieweb/ui, not here) |
| `vendor/yorm` → github.com/mieweb/yorm | U6 only | 0.1.0 fixed-version packages; the spike wants source access (patient-collab Zustand bridge as reference, transport experiments against serve) | U6 recommendation lands: adopt → pinned npm `@yorm/*` deps and submodule dropped; reject/defer → submodule dropped with the writeup |
| Ozwell agent (repo TBD) | U4 | Only if the owner-supplied entry point is a pre-release SDK/embed rather than a published package or hosted script | integration surface is a published artifact |

**Explicitly NOT vendored**: `@artipod/core` (this repo, `file:../..` + export-static refresh already handles it), zustand/xterm/next/tailwind (published, stable), just-bash (upstream vercel-labs, not ours to patch).

Mechanics (set up in U0, binding for all entries):
- Submodules live at repo-root `vendor/`, consumed by the SPA as `file:` deps with `install-links=true` — npm COPIES linked packages, so after editing a vendor package: rebuild its dist, reinstall in the app, and clear `.next`/vite caches before concluding a fix didn't work (documented failure mode).
- **No bundler aliases into vendor source trees** — aliases pass locally and fail the moment CI or a fresh clone builds against the published dist-only package. `file:` against the submodule's *built* output only.
- Commit discipline: commit/push in the submodule first, then bump the pointer here; CI (`build:ui:spa`) must `git submodule update --init` — and the U7 cutover gate re-verifies the app builds with **zero** submodules initialized once exits are met.
- Vendor patches are upstream PRs from day one; the submodule pointer tracks our branch only until the PR merges and ships.

## 3. State inventory — everything the monolith juggles, and where it goes

The heart of the problem: **ten kinds of state in five uncoordinated homes.** Target: four zustand stores + three services.

| State | Today (home / mechanism) | Target |
|---|---|---|
| Broker status, lease, renewal, `released`, re-keying | `lib/keys.ts` module vars + hand-rolled `Set<listener>` | `brokerStore` (status/expiry/principal snapshots); `KeysService` owns login/renewal/fetch-patch |
| Device keypair + wrapped session (offline grant) | IndexedDB (`artipod-keys`) via inline IDB code | unchanged home; owned by `KeysService` (idb helpers extracted) |
| Unwrapped KEKs (CryptoKey) | `keys.ts` module map | `KeysService` private — exposed as `getKey(podId)`; NEVER in a store |
| Forced offline | pod settings (`/.artipod/oci/settings.json`) + localStorage boot mirror + module flag | `settingsStore` (fs-subscribed write-through; boot mirror kept) |
| Broker metadata cache | localStorage `artipod-broker-meta` | `brokerStore` persist partialize (metadata only) |
| Workspace registry (`LocalEntry`: mode, lastOpened, hasChanges, unsynced, encrypted) | fs `ui-state.json`, raw-OPFS IO, Web-Lock, read/patch helpers strewn through page.tsx | `registryStore` — same file, one module owns IO; optimistic cache + write-through |
| Server refs (+ `encrypted`/`locked` decor) | `useState` + fetch effect | `catalogStore.refreshServer()` |
| Local heads, sync verdicts (ancestry), changed refs | three `useState`s + two interdependent effects + an OciStore constructed inline | `catalogStore` actions calling `CatalogService.computeVerdicts()` (owns the read-only OciStore + isAncestor walk) |
| Pod / sandbox / events / hydrator instances | `useRef`s + `window.__artipod` | `PodSessionService` — id-keyed session registry; `workspaceStore` holds `{id, phase: opening/ready/error, root, basisAt}` snapshots |
| Workspace view state (activeView, editingFile, termOpen/height, publish panel) | seven `useState`s | `workspaceStore` ui slice |
| Sync status (pending/synced/failed) + push retry (boot, reconnect, 15s) | component state + closures over `needsPush` inside a 400-line effect | `workspaceStore.sync` slice; retry + renewal timers become named tasks in the client lib's TaskScheduler (introspectable — feeds `artipod ps`) |
| PodEvents → UI | ad-hoc `events.on` with page-lifetime leaks (acceptable only because navigation reloads) | one `bridgePodEvents(session, stores)` with explicit unsubscribe — mandatory once U5 removes reloads |

## 4. Architecture

```
        @mieweb/ui components (thin, token-styled)
                    │  useStore bindings
        zustand stores: broker · settings · registry · catalog · workspace
                    │  actions ⇄ subscribe
        services = the CLIENT LIB (D2; framework-free, DOM-free, unit-tested;
                   runs in browser and node isolates via injected adapters):
          KeysService        (login/lease/fetch-patch/offline-grant, from lib/keys.ts)
          PodSessionService  (createZenFsPod lifecycle: open/dispose/retry-push)
          CatalogService     (server refs, local heads, ancestry verdicts)
          TaskScheduler      (renewal/retry/refresh as named tasks → `artipod ps`)
          state IO           (ui-state.json, pod settings, idb helpers)
                    │
        @artipod/core (+ /sandbox /oci /manager /host) ── artipod serve (/api, /v2)
```

- **Routing**: stays URL-shaped (`/?artipod=<ref>&mode=`) for link-compat, parsed into a `route` slice. U2–U4 keep the old full-reload semantics between catalog↔workspace (the "one fs boot per page" assumption holds). U5 replaces reloads with `PodSessionService.close()` → `open()` transitions.
- **The fetch patch** (lease header, forced-offline, 401-retry) stays exactly one chokepoint, installed by `KeysService` before anything renders — it is the part of `lib/keys.ts` that WORKED; it moves, it does not change.
- **Store hygiene rules**: stores are serializable snapshots; derived data (verdicts, badges) computed in actions, selected with shallow selectors; no store-to-store imports — services compose stores.

## 5. Phases

### U0 — scaffold + build pipeline parity

- [ ] `examples/artipod-spa`: Next (same major as artipod-sync), `output: 'export'` unconditional, no `app/api`, tailwind + @mieweb/ui installed (tokens wired, dark mode default like the old app); `.npmrc` `install-links=true` + the export-static core-copy refresh (both landmines from the old app carry over)
- [ ] Vendor scaffolding (§2.5): add `vendor/ui` submodule, consume as `file:` dep against its built dist; document the edit→rebuild→reinstall→clear-cache loop in the app's AGENTS.md; CI/`build:ui:spa` runs `git submodule update --init`
- [ ] zustand + a `createStore` vanilla pattern with one example store round-tripped through a vitest unit test
- [ ] Dev loop proven: `artipod serve --encrypt --publish <tmp>` + `next dev` rewrites — catalog placeholder lists real refs through the proxy
- [ ] Build: `npm run build` exports; struct-minify marker assertion passes; `ui-buildinfo.json` baked; `ARTIPOD_UI_DIR=examples/artipod-spa/out artipod serve` serves it
- [ ] Root `package.json` gains `build:ui:spa` (parallel to `build:ui`) — dist-ui swap happens only at U7
- [ ] **Done when**: the placeholder SPA serves from a broker serve with live refs, both build modes green, old app untouched

### UE — DRY the embed story (incorporates `dry-example-server-plan.md`)

Runs before or parallel to U1 — it touches core + the OLD app only, no SPA dependency. The detailed spec (exact code, tests, gotchas, acceptance) is `dry-example-server-plan.md`; that file is the authority for HOW, this section fixes WHY-here and WHAT-survives. Commit the dry plan file alongside this one when the milestone starts.

- [ ] **E1 — `toNodeHandler(app)` export** (core, permanent): lift the existing `toRequest`/`dispatch` bridge out of `serveApp`'s privacy, export from `/server`, `serveApp` re-uses it (one dispatch path); node:http tests (GET/streamed PUT/HEAD-no-body/500 JSON); "Embedding in your own server" section in `docs/serve.md` (Express, Hono/fetch-native, Next route snippets; root-mount + Fastify caveats). This IS deliverable D4's other half: serve-as-pure-API only matters if the API embeds in YOUR server in a few lines.
- [ ] **E2 — old app's four API routes collapse onto one `createArtipodApp` catch-all** (interim, dies with the app at U7): its value here is de-risking P2 — the composed handler carries the demo UI's real traffic (pods/oci/git/exec) for the whole parallel period, so the SPA never discovers a coverage gap late. Also shrinks the frozen app's maintenance surface.
- [ ] **E3 — delete the example's `PublishMap` fork** (interim): old app consumes core `PublishMap`/`withinRoots`; on-disk `publish-map.json` format unchanged.
- [ ] **E4 — wrap-up**: old-app README points at the catch-all + embed docs; CHANGELOG notes `toNodeHandler`; line-count check (~200 → ~60 in api+glue).
- [ ] **Done when**: dry-example-server-plan's own acceptance criteria all pass (build + manual smoke of pull/terminal/git-clone/push + publish round-trip) and the old demo behaves identically. Note for U7: E2/E3's app-side code is deleted with the app — planned and fine; E1 + docs are the permanent residue.

### U1 — services + stores, no React

- [ ] Extract `KeysService` from `lib/keys.ts` (fetch patch, device keypair, wrapped-session persistence/restore, renewal, release, forced-offline enforcement) + `brokerStore`/`settingsStore`; behavior-parity unit tests (fake fetch + fake IDB): login, ECDH unwrap, restore-before-probe, offline blocks rawFetch, failed-probe non-memoization, release suppresses auto-relogin
- [ ] State IO module: ui-state.json read/patch (raw-OPFS + Web-Lock, lifted from page.tsx), pod-settings read/write (wraps core `readPodSettings`), idb helpers; `registryStore` with write-through
- [ ] `CatalogService.computeVerdicts()` (local OciStore + `isAncestor`, broker-key decrypt, locked fallback) with unit tests over an InMemory store — the logic currently living in two page effects
- [ ] `PodSessionService.open(route) → session` / `close(id)` wrapping today's 300-line workspace effect: upper selection (block-store vs legacy), `authority.adopt`, publish handler, push-retry (boot/reconnect/15s), event bridge; unit-test the pure parts (upper naming, retry state machine)
- [ ] The services ARE the client lib (D2/P10): no DOM/window assumptions outside injected adapters (fetch, key-value storage, locks, timers) so the same code runs in browser and node isolates — prove it by running the service unit tests under plain node with node adapters; packaging decision (core `/client` subpath export vs new `@artipod/client` package) made and recorded here at gate time
- [ ] TaskScheduler in the lib: key renewal, push retry (boot/reconnect/interval), verdict refresh registered as named tasks with state/next-run/last-result introspection — the substrate for `artipod ps` (wired to the shell in U3)
- [ ] **Done when**: `pnpm/npm test` in the new app covers the services with zero React imports AND passes under node adapters, and the OLD app still builds (nothing moved out from under it — extraction is copy-first, the old app keeps its own copies until U7)

### U2 — catalog

- [ ] Catalog page on `catalogStore`/`registryStore`/`brokerStore`: server list (repo grouping, digest chips, locked/encrypted/e2e/plaintext chips, ancestry verdict badges incl. heal), local list (publish affordance, drafts), new-workspace, root console entry
- [ ] Header cluster as @mieweb/ui components: EncryptionBadge (leased/re-keying/locked + release), OfflineToggle, all tooltips carried over verbatim (they encode the honest semantics)
- [ ] **Done when**: side-by-side with the old catalog against the same broker serve, every row shows identical badges through: edit-offline, aborted-push, reopen-heal, release-lease, offline-reload scenarios (scripted via page.evaluate, as done this week)

### U3 — workspace shell

- [ ] Workspace route renders from `workspaceStore` + `PodSessionService` (still full-reload navigation); top bar: EncryptionBadge, SyncStatus, OfflineToggle, mode chip, tabs
- [ ] Publish flow (push-back / publish-as / blank-publish) as a store action + @mieweb/ui inline panel
- [ ] `artipod ps` (D2): the client lib registers its task table as a proc provider; new `artipod ps` shell verb (core, `src/oci/command.ts`) prints sync + key scheduling — task, state, next run, last result — from the root console and workspace terminal
- [ ] **Done when**: the S5.5-era workspace verifications replay green: encrypted upper (hashed block dir on raw OPFS), boot push of pending changes, `artipod offline on|off` flips the chip live, lease renewal re-keys the pod

### U4 — panels

- [ ] Port Terminal (xterm), FileTree, StorageSettings onto stores (kill their prop-drilled callbacks); restyle chrome with @mieweb/ui
- [ ] Terminal graduates into the reusable **artipod-shell component** (D3): embeddable xterm wrapper with a narrow contract (`attach(sandbox)` / `dispose()`, disposable mount container), consumed by the app like an external component; packaging home (inside the client lib vs alongside) decided at gate
- [ ] Editor = **kerebron** (P8), NOT a Monaco port: CoreEditor in a disposable child div (`destroy()` replaces the mount node with a clone), `@kerebron/{editor,editor-kits,wasm}` current peers, wasm assets served under the static export, kerebron.css + `--mieweb-*` token pass, `loadDocumentText(mediaType, …)` seeded from the pod file, save-back through the pod; never CSS-transition the editor's width (menu ResizeObserver rebuild storm)
- [ ] Agent = **Ozwell** (P9), replacing AgentPanel: pin the integration surface with the owner first (embed/SDK/API), then wire it to the same pod tools the old panel exposed
- [ ] Editor state (`editingFile`, dirty, save) into `workspaceStore`; `edit:request` events through the bridge
- [ ] **Done when**: full manual pass of edit(kerebron)/save/tree/terminal/agent(Ozwell) covers the old app's behaviors, `artipod ps` shows live tasks from the workspace terminal, dark mode verified

### U5 — true SPA navigation

- [ ] Client-side route transitions: catalog ⇄ workspace ⇄ workspace with `PodSessionService.close()` (dispose pod, unmount overlay/upper mounts, release Web Lock, unregister proc providers) then `open()` — **the phase that pays for the rewrite**
- [ ] Known landmines to clear, each with a regression test or scripted browser check: ZenFS global `mounts` (umount everything a session mounted), proc registry single-provider collisions, disposable containers for xterm/kerebron (CoreEditor.destroy() leaves a dead clone in the mount node), event-bridge unsubscribe audit (no page-lifetime leaks left), `beforeunload`-less push flush on route change (`await pushBasis()` before close — fixes the aborted-push residue properly)
- [ ] **Done when**: catalog → doug:_1 → lin:_1 → catalog without a page reload, mounts/`/proc` clean after each hop (verified via root console `ls /.artipod/upper` + `lsmod`), and the mid-push navigation scenario ends synced (flush-on-close), not 'out of sync'
- [ ] Stretch (explicitly optional): two workspaces open side-by-side in one page — the payoff U5 makes possible; do not start without a gate note

### U6 — yorm spike (gated; adoption is ask-first)

Question to answer: is `@yorm/*` the right engine for **multi-editor** — concurrent editing of the same file from two tabs/users — and for retiring the "one tab at a time" banner?

- [ ] Transport reality check first: `@yorm/server` needs WebSocket; `artipod serve` is a Fetch handler + node adapter with no WS. Spike options: (a) `serveApp` grows an opt-in `upgrade` hook (core change, ask-first), (b) yorm sidecar process next to serve, (c) defer transport and spike y-webrtc tab-to-tab only. Pick the cheapest that proves value.
- [ ] Spike scope: the kerebron buffer bound to a `Y.Doc`, roomed per `<ref>:<path>`, seeded from the pod file, written back through the pod on idle/save (yorm's trigger-policy model); artipod snapshots/push stay the durability layer — Yjs is the LIVE layer only, mirroring yorm's canonical-object/projection split
- [ ] P8 reframes the comparison: kerebron ships `extension-yjs` natively, so the spike weighs **yorm** (object graph, trigger policies, Yjs⇄Zustand bridge — wins if collab should extend beyond the editor to registry/catalog state) against **bare kerebron extension-yjs** (editor-only collab, zero new deps) — the known join-race/blank-room workarounds from @mieweb/ui RichEditor apply to both
- [ ] Evaluate against the kerebron/yjs lessons (repo-external memory): empty-room seeding races, lingering clients re-pushing stale docs — check whichever runtime handles these before trusting it
- [ ] **Done when**: a written recommendation lands in this file — adopt (with transport plan + which `@yorm/*` packages), defer to layer-plan Phase 7, or reject — plus a demoable two-tab edit if the transport allowed it. No production wiring in this phase.

### U7 — cutover

- [ ] Parity checklist replayed and pasted into the worklog: every scenario from §5 phase done-whens, against one broker serve session
- [ ] `build:ui` points at artipod-spa; `dist-ui` ships it; version-skew warning (`ui-buildinfo.json`) intact; conformance/publish workflows updated
- [ ] Retire `examples/artipod-sync` (ask-first): delete app + its API routes and vitest config; `examples/README.md` updated; serve-plan e2e section notes the catch-all refactor was done (UE) and then retired with the app
- [ ] Sample-site redeploy (ask-first): `artipod serve --publish … --encrypt?` behind the load balancer replaces `next start`; new `deploy/` unit + runbook in the SPA's AGENTS.md
- [ ] **Done when**: `npx artipod serve` ships the new UI to a fresh machine, the old app is gone, and this plan's tracker is all-done

## 6. Risks & landmines

| Risk | Phase | Mitigation |
|---|---|---|
| ZenFS mounts/proc registry are page-global singletons — SPA transitions leak or collide | U5 | `PodSessionService.close()` owns full teardown; root-console `ls`/`lsmod` checks in the done-when; U2–U4 keep reload semantics so the risk is isolated to one phase |
| kerebron/xterm mount lifecycle: CoreEditor.destroy() clones the mount node; menu ResizeObserver rebuilds the toolbar on any animated width change | U4/U5 | disposable child containers, never mount into a ref div directly, never CSS-transition the editor's width |
| kerebron under static export: wasm asset serving + peer version churn | U4 | serve `@kerebron/wasm/assets`; current peers (≥0.8.6); @mieweb/ui `kerebron` entry as prior art |
| Ozwell integration surface undefined at plan time | U4 | entry point pinned with the owner before U4 starts; AgentPanel's pod-tool contract is the spec |
| Vendor submodules outlive their purpose and become silent forks | U0–U7 | every §2.5 entry has a written exit; patches are upstream PRs from day one; U7 gate re-verifies a zero-submodule build |
| npm copies `file:` deps — vendor edits silently invisible to the app | U0–U6 | documented loop: rebuild vendor dist → reinstall → clear `.next` cache; never alias bundlers into vendor src |
| @mieweb/ui + existing tailwind fight over theming | U0/U2 | tokens-only rule; dark-mode check in every UI gate |
| Struct-minify regression in a fresh Next config | U0 | the marker assertion runs in the U0 gate, copied from export-static.mjs |
| Two apps drift during the parallel period | U1–U6 | old app is frozen except critical fixes; parity checklist is the contract, not code sharing |
| Store-persist leaks secrets | U1 | persist partialize allowlists (metadata only); review in the U1 gate; keys live in KeysService closures |
| yorm pulls a WS server into a Fetch-handler world | U6 | transport reality check FIRST; sidecar fallback; adoption ask-first |
| Registry/ui-state.json format drift breaks old↔new coexistence during migration | U1 | same file, same schema; additive fields only until U7 |

## 7. Reference map

| You need | Where |
|---|---|
| Everything being replaced (read before porting a behavior) | `examples/artipod-sync/app/page.tsx`, `lib/keys.ts`, `components/{EncryptionBadge,SyncStatus,OfflineToggle,Terminal,Editor,FileTree,AgentPanel,StorageSettings}.tsx` |
| Pod lifecycle the session service wraps | `createZenFsPod` (`src/realize/zenfs.ts`), `ZenFsPodOptions.authority/sync/hydration` |
| Keys/lease machinery | `@artipod/core/manager` (`unwrapLoginResult`, `PodLocker.adoptLease`, `Keyring`), serve `/api/keys` (`docs/serve.md#encrypted-pods-and-key-leases-s55`) |
| Encrypted uppers / offline setting / verdicts | `encryptedStoreMount` (`/sandbox`), `readPodSettings` (`/oci`), `isAncestor` (`/manager`) |
| Build pipeline to clone | `examples/artipod-sync/scripts/export-static.mjs`, root `scripts/buildinfo.mjs`, `npm run build:ui` |
| UE detailed spec (code, tests, acceptance, gotchas) | `dry-example-server-plan.md` (local WIP — commit with this plan when UE starts); `src/server/{app,node,publish-map}.ts` |
| Deployed-site constraints | `examples/artipod-sync/AGENTS.md` (sample-site runbook — superseded at U7) |
| kerebron integration prior art | @mieweb/ui `kerebron` entry: peers `@kerebron/{editor,editor-kits,wasm}`, `kerebron.css`, wasm assets at `/kerebron-wasm`; destroy/menu/join-race gotchas recorded in user memory |
| Ozwell agent | entry point TBD — pinned with the owner at U4 start; old `components/AgentPanel.tsx` defines the pod-tool contract to preserve |
| yorm | github.com/mieweb/yorm (`@yorm/{core,yjs,server,hono}` 0.1.0, ESM, node ≥20; Yjs⇄Zustand bridge in its patient-collab demo; PLAN.md M0–M8 shipped) |
| This week's behavior contract (what parity means) | serve-plan S5.5 worklog + addenda; repo memory: badges, verdicts, offline, lease persistence semantics |

## Worklog

### U0 — scaffold + build pipeline parity (2026-09-03)

Shipped `examples/artipod-spa`: Next 15 with `output: 'export'` unconditional, no `app/api`, dev-only rewrites proxying `/api/*` + `/v2/*` to `ARTIPOD_SERVE_URL` (default 2784); SkipStructChunkMinify + node:-scheme handling carried over; `.npmrc install-links=true`; `scripts/export-static.mjs` (core-copy refresh + stale-version refusal + struct-minify/version assertions + ui-buildinfo.json); vanilla `catalogStore` + vitest round-trip tests (pattern-setter for P4); root `build:ui:spa`; AGENTS.md with the dev loop and landmines.

**Deviations (rule §0):**
- **`vendor/ui` submodule deferred.** Published `@mieweb/ui` 0.7.3 needs only react/react-dom (all other peers optional) and ships compiled CSS — a `file:`-against-dist submodule would force every clone/CI to build the mieweb/ui monorepo for zero benefit today. §2.5's entry activates the moment the first patch is needed; the AGENTS.md loop is pre-documented.
- **Tailwind v4, not v3.** @mieweb/ui's `styles.css` is Tailwind v4-compiled; v3's postcss plugin rejects its `@layer` rules (`@layer base is used but no matching @tailwind base`). App uses `@tailwindcss/postcss` v4, CSS-first config, `@custom-variant dark` for the class strategy. This is the §6 "ui + tailwind fight" risk landing on day one — resolved by matching generations.
- Export script scans chunks **recursively** (app-router page chunks live under `chunks/app/…`; the old app's top-level-only scan would have missed the baked version here).

**Verification (all green):**
- app `npm install` / `test` (2 tests) / `typecheck` / `lint` — pass.
- `npm run build:ui:spa` → "static export ready in out/ (struct-minify + version assertions passed — 0.9.1+21 (b80eeb7-dirty, 2026-09-03))".
- `ARTIPOD_UI_DIR=examples/artipod-spa/out node dist/cli.js serve --port 2785 --encrypt` → browser snapshot shows "core 0.9.1+21 … · zenfs ok" and all three refs (test:_1, lin:_1, doug:_1) with 🔒 encrypted markers — live from the broker store, ref reads leaseless as designed.
- Dev loop: `ARTIPOD_SERVE_URL=http://127.0.0.1:2785 npm run dev` → `curl localhost:3600/api/pods/refs` returns the store's refs through the proxy (Next's "rewrites will not automatically work with output: export" warning applies to the exported artifact, not `next dev` — verified working).
