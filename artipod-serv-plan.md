# artipod serve plan — one command, a sync server and a registry you can embed

**Status**: Living implementation plan — the implementer updates this file as work proceeds (same rules as `artipod-layer-plan.md` §0)
**Date**: 2026-09-01
**Owner / Implementer**: horner (phase gates self-reviewed)
**Follows**: `artipod-layer-plan.md` (Phases 0–6.6) and `sync-demo-plan.md` (Phases A–F, all done). This plan is the next workstream; it does not reopen ratified decisions from those plans — it builds on them. In particular sync-demo D2 (single package, `/server` subpath heft) and D8/D9 (LWW + pluggable mergers) are load-bearing here.

## 0. How to work this plan

The working rules, commit conventions, phase-gate ritual (`docs(plan): serve phase SN gate`), verification rule (paste command + result into the worklog), and deviation rule are **identical to `artipod-layer-plan.md` §0** — read that first if you haven't. Extra rules for this plan:

- Phases strictly S0 → S6, except **S2 and S3 may run in parallel** (they touch disjoint code: UI pipeline vs `/v2/` handler). S5.5 requires S5 (leases ride the identity hook). Everything else gates in order.
- CLI tests spawn `dist/cli.js` — always `npm run build` before `npm run test` (learned repeatedly; it will bite you in S0's serve smoke test).
- `npx tsc --noEmit -p tsconfig.json` before every gate (CI can't see test-file type errors — learned in 6.6).
- Anything that binds a real port in tests uses `--port 0` (OS-assigned) and reads the printed URL; never hardcode a port in a spec.
- The `serve` code path must stay **lazily imported** from `src/cli.ts` (dynamic `import()` inside the verb, same as the dockerode value-isolation pattern) so `artipod run` never pays for server code.

### Ask-first list (owner sign-off required)

- Publishing any `@artipod/core` release that first exposes `createArtipodApp` / the `serve` verb, and the paired `artipod` shim republish.
- ~~The home of the UI artifact (proposed: `ghcr.io/mieweb/artipod-ui`, public anonymous pull) and every push of it~~ — **dropped 2026-09-02** (V6 re-amendment: the UI ships bundled in the npm package; no remote artifact exists).
- Anything touching the deployed artipod-sync service (`deploy/artipod-sync.service`, prod env) — the S2 demo refactor onto `createArtipodApp` redeploys it.
- Enabling `docker push` (S4) on any non-localhost deployment — write surface on a real network needs the owner to bless the token story first.
- Binding a **key-issuing** serve (S5.5, `--authority`) to non-localhost — the authority dir holds raw KEK material; the owner blesses its custody (permissions, backup, host) before it faces a network.

### Phase tracker (keep current)

| Phase | Branch | Status | PR |
|---|---|---|---|
| S0 — node adapter + `createArtipodApp` + `serve` verb | main | **done** (2026-09-02) | |
| S1 — `--publish` folder delight + auto-token + landing | main | **done** (2026-09-02) | |
| S2 — ship the sync demo UI (static export, bundled in the npm package) | main | **done** (2026-09-02) — npm bundling superseded the ghcr artifact; demo catch-all refactor + CI both-modes job moved to the e2e close | |
| S3 — OCI distribution read (`/v2/` pull) | main | **done** (2026-09-02) | |
| S4 — OCI distribution write (push + conformance) | main | **done** (2026-09-02) | |
| S5 — static token auth across all surfaces | main | **done** (2026-09-02) | |
| S5.5 — key leases + encrypted publish (`/api/keys`) | main | **done** (2026-09-02) | |
| S6 — pull-through cache + `artipod replicate` | `serve-s6-replicate` | todo | |
| S7 — OIDC / RBAC / mirroring / TLS | — | future — documented only (§5) | |

### Reference map

| You need | Where |
|---|---|
| Existing Fetch-style handlers (pods, relay, git, exec) + `AuthHook`/`bearerAuth` | `src/server/index.ts`, `src/server/common.ts` |
| Blob/ref sync surface with LWW merge-on-push | `src/server/pod-store-handler.ts` (+ `src/manager/merge.ts` `mergeHeads`) |
| CORS pattern to copy (only handler that has it today) | `src/server/git-proxy.ts` |
| Folder publish + write-back materialize | `src/server/folder.ts` (`publishDirectory`, `materializeRef`) |
| `PodStore` contract + directory/HTTP implementations | `src/manager/pod-store.ts` (`OciLayoutPodStore`, `HttpPodStore`) |
| Anti-entropy blob/ref sync between stores (S6 reuses wholesale) | `src/manager/sync.ts` (`storeTransport`) |
| Digest/tar/transport primitives; `DirectRegistryTransport` for self-pull tests | `src/oci/` |
| CLI verb dispatch style + test harness pattern (`ARTIPOD_PODS` scratch root) | `src/cli.ts`, `src/cli.test.ts` |
| The npx shim (stays thin per V6 — 4 files, no UI payload) | `packages/artipod/bin.mjs`, `packages/artipod/package.json` |
| Pull machinery the UI-artifact fetch reuses | `src/oci/pull.ts`, `src/oci/transport.ts` (`DirectRegistryTransport`) |
| Demo route wrappers to be replaced by one catch-all | `examples/artipod-sync/app/api/**` |
| Demo server glue patterns (store singleton, publish map) | `examples/artipod-sync/lib/pods-store.ts`, `lib/publish-map.ts` |
| Next static-export landmine (SWC minifier vs ZenFS structs) | `examples/artipod-sync/next.config.js` (SkipStructChunkMinify) |
| Encryption at rest (chunked AEAD, `.alias` ciphertext twins, `getRawBlob`) | `src/oci/cipher.ts`, `src/oci/store.ts` (`enableEncryption`) |
| Keyring TTL + leases + login (Phase 6.5 — S5.5 puts an HTTP face on it) | `src/manager/keyring.ts`, `src/manager/authority.ts`, `src/manager/locker.ts`, `src/__tests__/encryptedPod.spec.ts` |
| Sync semantics the server must honor | `docs/sync.md`, `docs/security-model.md` |

## 1. Goal — the north star

> `npx artipod serve --publish ./my-notes` prints one URL. Open it: the full artipod-sync experience — terminal, editor, file tree — running against *your* folder, live, bidirectional. The same server is a real OCI registry: `docker pull localhost:2784/my-notes:latest` works, `crane ls` works, and after S4 `docker push` works. Bind to `0.0.0.0` and it prints a token instead of trusting the LAN. And when you decide you want this inside your own app, the punchline is that you already have it: the CLI hosts a single `createArtipodApp()` Fetch handler, and embedding is one import + one route.

Success = a scripted e2e that replays the sync-demo north-star paragraph (`sync-demo-plan.md` §1) against `artipod serve` instead of the Next.js dev server, plus the registry conformance suite green.

### Decisions ratified 2026-09-01 (owner-answered; do not relitigate)

| # | Decision |
|---|---|
| V1 | **One verb: `artipod serve`** (spelling `serve`, not `serv`). Default = every surface; `--only web` / `--only registry` narrow it. No separate `web`/`registry` verbs. |
| V2 | The registry speaks the **full OCI Distribution API** (`/v2/`: pull *and* push — docker/crane/skopeo interop) **alongside** the native `/api/pods` sync surface. Native keeps merge semantics; `/v2/` is the interop face. |
| V3 | Auth v1 = **anonymous (localhost) + static ro/rw tokens** only, accepted as both `Bearer` and `Basic` (any username, token as password — so `docker login` works). OIDC is a *designed-not-built* identity hook (§5); LDAP/AD and SAML are **never native** — the documented recipe is an IdP bridge (Dex/Keycloak) in front of the OIDC hook. |
| V4 | `artipod serve` ships the **full sync demo UI** as a Next.js static export served at `/` (same-origin with the API — the shipped UI needs no CORS). Delivery mechanism is V6 (pulled OCI artifact, not bundled). |
| V5 | Replication v1 = **pull-through cache** mode + one-shot **`artipod replicate <src> <dst>`** (reuses `src/manager/sync.ts` anti-entropy). Continuous mirroring is future (§5). |
| V6 | Packaging: **no new npm package** (upholds layer-plan Decision #2 / sync-demo D2). *(Re-amended 2026-09-02, owner-ratified — supersedes both earlier wordings:)* **the UI ships bundled in `@artipod/core` itself** as `dist-ui/` (in the package `files`, built by `npm run build:ui` / the publish workflow). The measured export is far smaller than feared (~1.3 MB imported; whole package 1.7 MB gz / 5.8 MB unpacked), so npm bundling beats the ghcr OCI artifact on simplicity and offline-completeness — the **digest-pinned remote artifact, ghcr push, and first-serve remote fetch are DROPPED**. Resolution order: `ARTIPOD_UI_DIR` → `artipod-ui:latest` in the store (a deliberate override, materialized to `~/.artipod/ui/<digest>`) → bundled `dist-ui` → headless landing. `--no-ui` / `--only registry` stay headless; `@artipod/core/server` stays bring-your-own-auth. |
| V7 | Default port **2784** ("ARTI" on a keypad), default host **127.0.0.1**. Non-localhost bind with no token configured → auto-generate a token and print it (Jupyter-style); localhost stays open by default. |
| V8 | Ref-write semantics split: the native `/api/pods/refs` surface keeps **LWW `mergeHeads`** on divergence (sync-demo D8/D9); `/v2/<name>/manifests/<tag>` PUT is **last-write-wins overwrite** (distribution-spec behavior — registries don't merge). A tag updated via `/v2/` is still a plain ref, so history stays reachable through `org.artipod.parents` where the pusher recorded them. Documented loudly in `docs/serve.md`. |
| V9 | *(ratified 2026-09-02)* **`artipod serve` acts as the key authority (broker)** for encrypted pods it owns: a `/api/keys` surface wraps the existing Phase-6.5 `Authority` — authenticated login → signed lease + KEKs, client adopts into its keyring. **Stated honestly in `docs/serve.md`: broker mode means the serve machine can decrypt what it brokers** (it holds raw KEK material; write-back materializes plaintext anyway). Pure E2E remains available: a keyless serve is a **blind host** — encrypted refs sync as opaque ciphertext with keys distributed out-of-band, and that path needs no new code. |
| V10 | *(ratified 2026-09-02)* Default key lease TTL **1h** (`--key-ttl` overrides; issued TTL = min(client-requested, server cap)). Semantics documented, not overpromised: client keyrings are **memory-only** (non-extractable WebCrypto keys) — closing the tab loses the key *immediately*; the TTL bounds an open session (keyring evicts → `PodLockedError` → re-login). Enforcement is **layered**: cooperative client eviction + the server's hard powers (refuse lease re-issue, refuse further ciphertext after expiry). True revocation of an already-leaked key = rotation/rewrap (§5). |

## 2. What already exists (build on it, don't rebuild it)

| Need | Have |
|---|---|
| Framework-agnostic Fetch handlers for pods/relay/git/exec | `src/server/` — `PathHandler = (req: Request, path: string[]) => Promise<Response>` |
| Blob PUT with digest verification, ref PUT with LWW merge, Range GET | `createPodStoreHandler` |
| GET-only upstream registry relay with host allowlist | `createRegistryRelayHandler` (S6 grows a cache under it) |
| git CORS proxy incl. preflight handling | `createGitProxyHandler` |
| Exec sessions with TTL host + bearer auth | `createExecSessionHandler` |
| Folder → per-file layers, and pushed heads → real files | `publishDirectory` / `materializeRef` |
| Directory store in standard OCI image-layout (skopeo-inspectable) | `OciLayoutPodStore` — **this is why S3/S4 are tractable: the storage is already the registry's native format** |
| Store-to-store anti-entropy with budgets | `src/manager/sync.ts` `storeTransport` (S6 = wire it to two stores and stop) |
| Browser client that already speaks the native surface | `HttpPodStore` + the whole artipod-sync UI |
| Node ≥20 baseline (native `Request`/`Response`/`fetch`) | `package.json` engines — the node:http adapter needs zero deps |

What does **not** exist: any actual HTTP server in core (only handler factories), CORS on anything but the git proxy, a `/v2/` distribution handler, identity beyond a single shared bearer token, replication commands, and a way to run the demo UI without Next.js serving it.

## 3. Design

### 3.1 `createArtipodApp` — the one object (S0)

New `src/server/app.ts`:

```ts
export interface ArtipodAppOptions {
  store: PodStore;                          // required — the one stateful thing
  surfaces?: { web?: boolean; registry?: boolean };   // default both true
  auth?: AuthHook;                          // S5 extends; absent = open
  cors?: string[];                          // allowed origins for pods//v2/relay; default []
  relay?: { allowedHosts: string[]; cache?: boolean };
  publishRoots?: string[];                  // authority check for materialize (re-run every time, never cached)
  exec?: ExecSessionHandlerOptions | false; // false = surface off
  ui?: { dir: string } | false;             // static dir; node-only; default false
  onRefPut?: PodStoreHandlerOptions['onRefPut'];
}

export function createArtipodApp(options: ArtipodAppOptions): (req: Request) => Promise<Response>;
```

Routing inside (first segment match): `/api/pods/*` → `createPodStoreHandler`, `/api/oci/*` → relay, `/api/git/*` → git proxy, `/api/exec` → exec handler, `/v2/*` → distribution handler (S3+, registry surface), `/*` → static UI when configured, else the S1 landing response. The returned function is WinterCG-shaped: it mounts unmodified in a Next.js catch-all route, Hono, `Bun.serve`, `Deno.serve`, or the S0 node adapter. **The CLI and an embedder's app run the same object** — that identity is the product.

CORS: one small wrapper applied to pods, `/v2/`, and relay responses (git proxy keeps its own `*` behavior — isomorphic-git requires it). Exact-match origins from `options.cors`, `OPTIONS` preflight answered locally, `Access-Control-Expose-Headers` includes `Docker-Content-Digest` and `Content-Range`. The shipped UI is same-origin and needs none of this; `--cors` exists for people pointing the *hosted* demo (or their own app) at a local server.

### 3.2 Node adapter (S0)

New `src/server/node.ts`: `serveApp(app, { port, host }) => Promise<{ url, close }>` over `node:http`. IncomingMessage → `Request` (duplex half, stream body), `Response` → res via `Readable.fromWeb`, preserving `Range`/`Content-Range` and not buffering blob bodies. ~80 lines, zero deps on Node ≥20. Deliberately not exported to browsers (server subpath is already `browser: false`).

### 3.3 CLI verb (S0/S1)

`src/cli.ts` gains `serve`, parsed in the existing manual-argv style:

```
artipod serve [--port 2784] [--host 127.0.0.1] [--store <dir>]
              [--publish <dir>]... [--only web|registry]
              [--token <t>] [--read-token <t>] [--cors <origin>]...
              [--oci-allow <host>]... [--cache] [--no-ui] [--no-exec] [--open]
```

- `--store` defaults to `~/.artipod/store` (env `ARTIPOD_STORE_DIR`) — an `OciLayoutPodStore`, sibling of the existing `~/.artipod/pods`. Note it is **not** the pods dir; `docs/on-disk-layout.md` gains a paragraph.
- `--publish <dir>` (repeatable): `publishDirectory` at boot, record in a publish map (port `lib/publish-map.ts` pattern into `src/server/`), wire `onRefPut` → `materializeRef` for write-back. The dirs become the publish-roots allowlist.
- `--only web` disables `/v2/`; `--only registry` disables pods/git/exec/UI. Default: both.
- `--no-exec`: exec surface off. When binding non-localhost, exec **requires** a token even if everything else is anonymous (it is arbitrary compute; `docs/security-model.md` cross-ref).
- Startup print: URL(s), store path, published refs, surfaces, and — per V7 — the generated token when applicable. `--open` launches the browser.
- Env fallbacks mirror the demo's names (`ARTIPOD_OCI_ALLOWED_HOSTS`, `ARTIPOD_PUBLISH_ROOTS`, `EXEC_API_TOKEN`) so existing deploy docs stay true.

### 3.4 Distribution handler (S3 read, S4 write)

New `src/server/distribution-handler.ts` over `PodStore`. Ref mapping: pod-store ref `"<name>:<tag>"` ⇄ `/v2/<name>/manifests/<tag>`; `<name>` may contain `/`.

Read (S3): `GET /v2/` (200 + `Docker-Distribution-API-Version`), `HEAD|GET /v2/<name>/manifests/<tag|digest>` (`Docker-Content-Digest`, `Accept` media-type negotiation, manifest lists passed through), `HEAD|GET /v2/<name>/blobs/<digest>` (Range), `GET /v2/<name>/tags/list` and `GET /v2/_catalog` (both with `n`/`last` pagination + `Link` header), OCI error-JSON envelope for every failure.

Write (S4): `POST /v2/<name>/blobs/uploads/` → session id; `PATCH` chunks accumulate to a temp file (never in memory — layers can be GB); `PUT ?digest=` verifies and `putBlob`s; monolithic `POST`+`PUT` also accepted (crane's happy path). `PUT manifests/<tag>` verifies every referenced blob exists before `putRef` (V8: overwrite, no merge). Upload sessions: in-memory map + temp dir, TTL evicted — restart drops them, which the spec permits (client re-POSTs).

Not in scope ever unless demanded: cross-repo blob mount is a *nice-to-have* box in S4 (cheap: same store, so it's a no-op 201), referrers API and artifact spec extensions are §5.

### 3.5 Auth (S5)

Extend `src/server/common.ts`: `AuthHook` may now return `true | false | Identity` where `Identity = { name: string; access: 'ro' | 'rw' }`. Existing boolean hooks stay valid (compat shim). New `staticTokenAuth({ rw, ro })` accepts `Bearer <t>` and `Basic base64(*:<t>)`; failures get `401` + `WWW-Authenticate: Basic realm="artipod"` (docker's client requires the challenge). Handlers gate writes on `access === 'rw'`. The CLI wires `--token`/`--read-token`/env into it; the V7 auto-token path generates 32 hex chars via `node:crypto`. OIDC lives behind the *same* `AuthHook` shape later (§5) — that's the whole point of returning an identity now.

### 3.6 Shipping the UI (S2)

Verified feasible: `app/page.tsx` is pure client-side (relative `fetch('/api/...')`, no SSR data), so a static export needs zero client changes. Pipeline:

1. `STATIC_EXPORT=1 next build` with `output: 'export'` in `next.config.js` (conditional). App-router API routes are not exportable → the build script **stashes `app/api/` aside and restores it** (`scripts/export-static.mjs`); the CLI *is* the API in this mode. The SkipStructChunkMinify plugin already in `next.config.js` carries over untouched — do not "simplify" it.
2. **Publish the export as an OCI artifact** (release step, ask-first): `publishDirectory` over the export dir → push to `ghcr.io/mieweb/artipod-ui`; the resulting **manifest digest is pinned as a constant in core** (`src/server/ui-ref.ts`), updated per release. No mutable tag is ever trusted at runtime.
3. **First-serve pull**: `serve` wanting a UI checks the local store; on miss it prints `fetching UI (≈4 MB) from <ref>@<digest>…`, pulls via the existing transport machinery into `~/.artipod/store`, digest-verifies (the pin *is* the verification), and materializes to `~/.artipod/ui/<digest>/`. Cached forever; a new core release with a new pin fetches once more. Offline miss → warn + S1 headless landing, never an error. Overrides: `ARTIPOD_UI_DIR` (serve a local build — dev loop), `ARTIPOD_UI_REF` (alternate artifact, must be digest-pinned).
4. Static file serving: tiny handler in `src/server/static.ts` (root-relative, no `..` traversal, content-type map, `index.html` fallback for the SPA). Node-only.
5. Same phase: **refactor the demo's five route files onto one catch-all** delegating to `createArtipodApp` — the demo becomes the first embedder, which is the parity proof that CLI and embedded behavior can't drift.

### 3.7 Replication (S6)

- **Pull-through cache** (`--cache`, registry surface): relay GET-miss → fetch upstream (existing allowlist), digest-verify, `putBlob`, then serve from the store forever after. Cached names live under `<host>/<name>` so they're also pullable via `/v2/`.
- **`artipod replicate <src> <dst>`**: one-shot; each side is a directory path (→ `OciLayoutPodStore`) or an `http(s)://` URL (→ `HttpPodStore`, `--token` per side). Body = `src/manager/sync.ts` anti-entropy: blobs are a G-Set (copy what's missing), refs advance by `mergeHeads` (or `--overwrite`). Content addressing means this is conflict-free by construction; only ref heads need thought, and that thought was already had in sync-demo D8.

### 3.8 Encrypted pods: key leases (S5.5)

Almost everything exists from layer-plan Phase 6.5; S5.5 is an HTTP face, not new cryptography. Facts the design leans on: `createPodStoreHandler` already moves encrypted blobs unmodified (ciphertext twins + `.alias`, `getRawBlob` for keyless relays); `Authority.login({principal, podIds, ttlMs})` returns `{lease (Ed25519-signed), keys}`; client `PodLocker.adoptLogin()` imports KEKs into a memory-only keyring that evicts on expiry (`PodLockedError`).

- **Two hosting modes, one honest table in `docs/serve.md`**: *blind host* (no keys — encrypted refs sync as opaque bytes, zero new code, server cannot read, D9 content mergers unavailable server-side) vs *broker* (V9 — serve owns the authority, issues leases, can decrypt).
- **Endpoints** (web surface, auth-required even on localhost — keys are never anonymous): `POST /api/keys/login` `{refs?, ttl?}` → authenticate (S5 identity) → `Authority.login` → `{lease, keys: {podId: base64 KEK}}`, TTL = min(requested, `--key-ttl` cap, V10 default 1h); `GET /api/keys` → caller's lease metadata (never key material — mirrors `Keyring.list()`).
- **Lease-scope enforcement**: the S5 `Identity` grows optional `lease` claims; the pods handler validates podId ∈ `lease.podIds` and GET/PUT against `lease.permissions` for encrypted refs. Expired lease → 401 with a `re-login` hint — the server's hard power is refusing re-issue and refusing further ciphertext.
- **CLI**: `--encrypt` (with `--publish`): boot creates/loads the authority at `~/.artipod/authority` (0700; contains raw KEKs — ask-first off-localhost), publishes via a store with `enableEncryption()` bound; `--key-ttl <duration>` sets the issue cap; `--authority <dir>` relocates custody. Without `--encrypt`/`--authority`, `/api/keys` returns 404 and serve stays a blind host for any encrypted refs pushed to it.
- **Browser client**: after `/api/keys/login`, `adoptLogin()` populates the sandbox keyring; open tab past TTL → `PodLockedError` → UI re-login prompt; closed tab = keys gone immediately (memory-only, non-extractable — V10).
- **Not in v1**: key rotation/rewrap, offline device grants (`issueGrant` envelope wrapping), per-path key scoping — all §5.

## 4. Phases

Every phase ends with the repo ritual: `npm run lint && npm run build && npm run test`, `npx tsc --noEmit -p tsconfig.json`, worklog updated, tracker flipped, `docs(plan): serve phase SN gate` commit.

### S0 — node adapter + `createArtipodApp` + `serve` verb

- [x] `src/server/node.ts` adapter (+ unit test: echo app, streaming body, Range passthrough, keep-alive close)
- [x] `src/server/app.ts` `createArtipodApp` composing the four existing handlers behind surface flags; 404 JSON for unknown routes
- [x] CORS wrapper (exact-origin match, preflight, expose-headers) applied to pods + relay; unit tests incl. deny-by-default
- [x] `serve` verb in `src/cli.ts` (lazy `import()`), flags `--port/--host/--store/--only/--cors/--oci-allow/--no-exec`; startup banner
- [x] `cli.test.ts`-style smoke: spawn `dist/cli.js serve --port 0`, parse URL, `GET /api/pods/refs` → `[]`, `PUT`+`GET` a blob round-trip, SIGTERM clean exit
- [x] Export `createArtipodApp` + adapter from `@artipod/core/server`; browser-guard test still green
- [x] **Done when**: the smoke test passes from a clean `npm run build`, and a manual `curl` session against `artipod serve` exercises blobs + refs + relay-deny + git-proxy preflight (paste transcript in worklog)

Worklog:

- 2026-09-02: S0 complete. New files: `src/server/cors.ts` (`withCors` — exact-origin, empty allowlist = passthrough/deny), `src/server/app.ts` (`createArtipodApp`), `src/server/node.ts` (`serveApp` node:http adapter, streams both directions, `closeAllConnections` on close), `src/server/serve.ts` (`runServe`, lazily imported from `cli.ts`). Tests: `node.test.ts` (6), `app.test.ts` (12 incl. CORS), `serve.test.ts` (CLI smoke, spawns dist/cli.js with `--port 0`). Gate: `npm run lint && npm run build && npx tsc --noEmit -p tsconfig.json && npm run test` → 43 files / 456 tests green.
- Manual curl transcript (dist/cli.js serve --port 0 --store $(mktemp -d)):
  - banner: `artipod serve listening at http://127.0.0.1:58345` + store path + surfaces
  - `GET /api/pods/refs` → `[]`
  - `PUT /api/pods/blobs/sha256:…` ("hello serve") → 201; `GET` → `hello serve`
  - `GET /api/oci/registry-1.docker.io/v2/` → 403 (relay deny-all)
  - `OPTIONS /api/git/github.com/x/y/info/refs` → 204 (git preflight)
  - `kill -TERM` → exit 0

### S1 — folder delight + auto-token + landing

- [x] Port publish-map into `src/server/publish-map.ts` (JSON file in the store dir); demo's `lib/publish-map.ts` becomes a re-export shim (deleted one release later, same ritual as Phase 2)
- [x] `--publish <dir>` repeatable: boot-time `publishDirectory`, `onRefPut` → authority-checked `materializeRef` write-back
- [x] V7 token behavior: non-localhost bind + no token → generate, print, require (all surfaces); localhost stays open
- [x] Headless landing at `/` (no UI dir): single inline-HTML page — served refs, store path, copy-paste `curl`/`docker pull` lines
- [x] `--open`; `docs/serve.md` first draft (quickstart + flag table + V8 semantics)
- [x] **Done when**: `artipod serve --publish <tmpdir>` round-trips the sync-demo write-back e2e (browser-side simulated via `HttpPodStore`): edit → push → file materializes; and a `0.0.0.0` bind prints a token that `curl` must present

Worklog:

- 2026-09-02: S1 complete. `src/server/publish-map.ts` (`PublishMap` class + `withinRoots` — parameterized, no env singletons). `createArtipodApp` grew a `fallback` option (anything outside /api and /v2); serve.ts supplies the headless landing there. `--publish` boot-publishes `<basename>:latest` with actor `serve:<hostname>`, records the map beside the store, and `onRefPut` re-checks `withinRoots` before every `materializeRef`. V7 token: `--token`/`ARTIPOD_SERVE_TOKEN`, else non-localhost bind generates 32 hex chars and `requireToken` wraps the whole app (OPTIONS preflights pass — they carry no credentials); exec auth falls back `EXEC_API_TOKEN` → serve token. `--open` via platform opener. `docs/serve.md` first draft. Tests (serve.test.ts): landing page, write-back e2e (client `publishDirectory` over `HttpPodStore` against the live serve → served file updated), 0.0.0.0 auto-token 401/200 matrix. Gate: lint/build/tsc/test → 43 files / 459 tests green.
- Deviation: the demo's `lib/publish-map.ts` re-export shim is DEFERRED until a core release ships `@artipod/core/server` publish-map — the demo installs the published package (0.7.x) and cannot compile against unpublished exports. Ties into the S2 demo refactor (ask-first anyway).

### S2 — ship the sync demo UI *(parallel-ok with S3)*

- [x] `scripts/export-static.mjs` in the demo: stash `app/api/`, `output: 'export'` build, restore *(the publish workflow builds the export on every release; a PR-CI both-modes job moved to the e2e close)*
- [x] ~~Demo refactor: five route files → one catch-all on `createArtipodApp`~~ — still open, **moved to the e2e close** (redeploy ask-first)
- [x] `src/server/static.ts` (traversal-safe, SPA fallback); `ui` option in `createArtipodApp`; `ARTIPOD_UI_DIR`/`ARTIPOD_UI_REF` + `--no-ui` in the CLI
- [x] ~~UI-artifact publish script (ghcr push) + pinned digest constant~~ — **dropped 2026-09-02** (V6 re-amendment): the UI ships bundled as `dist-ui/` in the npm package; `ui-ref.ts` keeps only the local-store `UI_REF`
- [x] ~~First-serve remote pull path~~ — **superseded**: local store-hit + materialize + headless shipped; the remote fetch was dropped with the ghcr artifact; the bundled `dist-ui` fallback is the batteries-included path
- [x] **Done when** *(rewritten with V6's re-amendment)*: on a machine with only the shim installed, `artipod serve --publish <dir>` opens the full terminal/editor UI at `/` with **zero network fetches** (bundled dist-ui), syncing against the local store — met by the 0.9.0 release

Worklog:

- 2026-09-02: S2 local-first slice done (owner directive: local testing must not fetch from ghcr when a local build exists). Resolution order in `resolveUiDir` (serve.ts): `--no-ui` → `ARTIPOD_UI_DIR` (index.html sanity-checked) → `ARTIPOD_UI_REF`/`artipod-ui:latest` in the store (materialized once to `~/.artipod/ui/<digest>`, mkdir before materializeRef — it realpaths the target) → remote pin (dormant: `UI_DIGEST=null` in ui-ref.ts) → headless landing. `src/server/static.ts`: traversal-safe, Next-export spellings (`page.html`, `dir/index.html`), SPA fallback only for extensionless paths. Demo: conditional `output:'export'` under `STATIC_EXPORT=1`, `scripts/export-static.mjs` (stash app/api, build, restore, struct-minify marker assertion) — verified: export builds (152 kB first-load), `artipod import out artipod-ui:latest` (51 layers, 1.3 MB), serve resolves from store, index+chunks+API all 200. Tests: static.test.ts (5), serve.test.ts UI-dir + store-ref paths. Gate: 490 tests green.
- 2026-09-02 (later): **S2 closed via npm bundling** — owner ratified the V6 re-amendment: `npm run build:ui` exports the demo into `dist-ui/` (gitignored, in the package `files`), the publish workflow builds it before `npm publish`, `resolveUiDir` grew the bundled-dist-ui fallback, and a `ui-buildinfo.json` version-skew warning covers stale UI builds. Shipped in **0.9.0**. `UI_REMOTE_REF`/`UI_DIGEST` and the dormant remote-fetch branch removed from `ui-ref.ts`/`serve.ts` when the plan was reconciled. Demo catch-all refactor + PR-CI both-modes job moved to the e2e close.

### S3 — distribution read (`/v2/` pull) *(parallel-ok with S2)*

- [x] `src/server/distribution-handler.ts`: `/v2/` ping, manifests HEAD/GET (tag + digest, content negotiation, `Docker-Content-Digest`), blobs HEAD/GET (Range), tags/list + `_catalog` (pagination), OCI error envelope
- [x] Ref-name mapping helpers + property tests (`<name>:<tag>` round-trip, nested names, digest refs)
- [x] Wire into `createArtipodApp` behind the registry surface
- [x] Smoke script: `crane pull` and `skopeo copy` from a `serve` instance seeded by `--publish` (document in worklog with versions)
- [x] **Done when**: `docker pull localhost:<port>/<name>:<tag>` succeeds against a served publish (daemon needs the port in `insecure-registries` — document in `docs/serve.md`)

Worklog:

- 2026-09-02: S3 complete. `createDistributionHandler` over `PodStore` (+ `distRef`/`parseDistRef`/`splitRepoPath` helpers, exported from /server); wired into `createArtipodApp` under `/v2/*` behind the registry surface, CORS-wrapped. Manifest media type: the manifest's own `mediaType` declaration wins over the ref record (manifest lists pass through). Tag lookup enforces distribution name grammar (lowercase) — which caught a test bug: mkdtemp dirs can contain uppercase, so the publish e2e now publishes a lowercase `my-notes` subdir. Tests: distribution-handler.test.ts (10) + /v2 assertions in the serve publish e2e. Gate: lint/build/tsc/test → 44 files / 470 tests green.
- Manual smoke (macOS, docker 29.4.0; crane/skopeo not installed locally — conformance suite runs in S4): `node dist/cli.js serve --port 0 --publish <tmp>/my-notes` → `curl /v2/` 200 + `Docker-Distribution-API-Version: registry/2.0`; `curl /v2/my-notes/manifests/latest` 200 + `Docker-Content-Digest`; **`docker pull 127.0.0.1:59128/my-notes:latest` → "Status: Downloaded newer image"** (127.0.0.1 is implicitly insecure for dockerd — other hosts need `insecure-registries`, noted in docs/serve.md).

### S4 — distribution write (push + conformance)

- [x] Upload sessions (POST/PATCH/PUT, temp-file accumulation, TTL eviction, monolithic path); manifest PUT with referenced-blob existence check; V8 overwrite semantics
- [x] Cross-repo mount = trivial 201 (same store) — box checked only if conformance wants it
- [x] Run the official `opencontainers/distribution-spec` conformance suite (pull + push workflows) in CI against `serve --only registry`; green or documented-excluded per test
- [x] `docker push` runbook verified manually; paste transcript
- [x] **Done when**: conformance green + `docker push` → `docker pull` round-trip → the pushed image also visible via native `GET /api/pods/refs`

Worklog:

- 2026-09-02: S4 complete. Upload sessions: in-memory map + temp-file accumulation (mkdtemp `artipod-uploads-`), TTL evicted (1h default), monolithic POST?digest= path, cross-repo mount = free 201 (one store). Manifest PUT: JSON-parses, existence-checks config/layers/child manifests — EXCEPT non-distributable/urls layers (foreign blobs) and `subject` (referrers land before/after their subject); V8 overwrite on tag refs via direct `store.putRef`. Conformance drove three extras beyond the plan: `OCI-Subject` response header, an **in-memory referrers API** (`GET /v2/<name>/referrers/<digest>`, artifactType filter + `OCI-Filters-Applied`; restart-lossy like upload sessions — documented), and full blob Range parsing (`A-`, `A-B`, `-N`, 416 + Content-Length on 206). PATCH/PUT chunks with a Content-Range that doesn't continue the offset → 416.
- Conformance (suite @ 9727462, go1.24.4, macOS): pull+push+content-discovery, content-management off → **450 passed / 81 failed / 168 skipped, ALL 81 failures are sha512 digest variants** — documented-excluded (Digest type is sha256-scoped; spec says SHOULD; docker/crane/skopeo push sha256). `.github/workflows/conformance.yml` runs the suite in CI against `serve --only registry` and fails on any non-sha512 failure (junit-parsed), uploading the report artifact.
- `docker push` runbook (docker 29.4.0): pull `my-notes:latest` from a --publish serve → retag → **`docker push 127.0.0.1:59514/pushed-back:v1` → "v1: digest: sha256:17f2… size: 720"** ("Layer already exists" — cross-repo dedup) → rmi → `docker pull` back OK → `GET /api/pods/refs` lists both `my-notes:latest` and `pushed-back:v1`. Gate: lint/build/tsc/test → 44 files / 479 tests green.

### S5 — static token auth everywhere

- [x] `AuthHook` → `true | false | Identity`; compat for existing boolean hooks; `staticTokenAuth` (Bearer + Basic, ro/rw); `401` + `WWW-Authenticate`
- [x] All handlers gate writes on `rw` (pods PUT, `/v2/` push, exec, publish); reads honor `ro`
- [x] CLI `--token`/`--read-token` + env; auto-token path switched onto the same code
- [x] `docker login localhost:<port>` with the token works (Basic path) — transcript in worklog
- [x] **Done when**: matrix test — {no token, ro token, rw token} × {native read, native write, v2 pull, v2 push, exec} behaves per table in `docs/serve.md`

Worklog:

- 2026-09-02: S5 complete. `common.ts`: `Identity {name, access}`, `AuthResult = boolean | Identity` (boolean hooks stay valid), `staticTokenAuth({rw, ro})` accepting Bearer + Basic(any-user:token), `authorizeAccess(req, auth, need)` → 401+`WWW-Authenticate: Basic realm="artipod"` / 403 for ro-on-write. Gating: pods + /v2 handlers gate internally by method (GET/HEAD=ro else rw; /v2 keeps its `readonly` option as an extra clamp); exec = always rw; relay/git/landing gated centrally in the app router (git POSTs count as reads — upload-pack is a fetch); OPTIONS preflights skip auth. serve.ts: `--token`/`--read-token` + `ARTIPOD_SERVE_TOKEN`/`ARTIPOD_SERVE_READ_TOKEN`, auto-token path now emits an rw staticTokenAuth token; `EXEC_API_TOKEN` remains an exec-specific override. Matrix test in app.test.ts ({none, ro, rw} × {native read/write, v2 pull/push, landing}, Bearer and Basic). Gate: lint/build/tsc/test → 483 green.
- docker login transcript (docker 29.4.0): serve with `--token s5-rw-secret --read-token s5-ro-secret` → `echo s5-rw-secret | docker login 127.0.0.1:18791 -u artipod --password-stdin` → **Login Succeeded**; `docker pull …/my-notes:latest` OK; curl matrix: no-token refs 401, ro refs 200, ro push 403, rw push 202.

### S5.5 — key leases + encrypted publish

- [x] Blind-host regression test first: keyless serve round-trips an encrypted ref (push ciphertext from an encrypted client store, pull on a second client, decrypt with out-of-band key) — proves the zero-code path before adding the broker
- [x] `src/server/keys-handler.ts`: `POST /api/keys/login` (S5 auth → `Authority.login`, TTL = min(requested, cap, 1h)), `GET /api/keys` (metadata only); wired into `createArtipodApp` behind a `keys` option *(spelled `keys`, not `authority` — it carries podIds/cap/enforce alongside the Authority)*
- [x] Lease-scope enforcement in the pods handler (podId ∈ lease.podIds, permissions vs method) for encrypted refs; expired → 401 + re-login hint *(as a `requireLease` wrapper around the pods surface; ref READS stay lease-free — pointers are the same metadata a blind host serves)*
- [x] CLI: `--encrypt`, `--key-ttl`, `--authority <dir>` (default `~/.artipod/authority`, 0700, created on first `--encrypt`); `/api/keys` 404 when no authority
- [x] Browser flow: login → `adoptLogin` → read/write encrypted pod; expiry mid-session → `PodLockedError` → re-login restores (test with fake clock)
- [x] `docs/serve.md`: blind-host vs broker table, the V10 layered-enforcement paragraph (no overpromising), `docs/encryption.md` cross-links
- [x] **Done when**: `artipod serve --publish <dir> --encrypt --key-ttl 1h` serves a pod whose blobs are ciphertext at rest; a client can login, read, write; the same store served by a *keyless* second instance still syncs the ref as a blind host

Worklog:

- 2026-09-02: S5.5 complete. New: `src/server/keys-handler.ts` (`createKeysHandler` + `requireLease` + `LEASE_HEADER`/`DEFAULT_KEY_TTL_MS`), `src/server/authority-dir.ts` (`loadOrCreateAuthority`/`ensurePodKek` — authority.json signing key + keks.json, 0700/0600, all created on first `--encrypt`; the owner directive "serve makes a key if one is not there" is this file). Enablers the plan hadn't costed: `generateSigningKeyPair(extractable)` + `exportSigningKeyPair`/`importSigningKeyPair` in crypto.ts (non-extractable keys cannot survive a restart — a persistent authority needs pkcs8 on disk); `Authority.from`/`podIds`/`hasPod` + `encodeLoginResult`/`decodeLoginResult` wire helpers (base64 KEKs); **`OciLayoutPodStore.enableEncryption`** mirroring OciStore's alias scheme — plaintext-addressed reads decrypt (or throw `PodLockedError` keyless), ciphertext-addressed reads stay byte-exact so blind relaying of foreign ciphertext is untouched; pods handler maps `PodLockedError` → **423 Locked**. serve.ts: broker boot BEFORE `--publish` (first snapshot already lands encrypted), `<store>/store-id.json` pod identity, `parseKeyTtl` (`<n>(ms|s|m|h|d)`), banner prints "broker ON — THE SERVE MACHINE CAN DECRYPT WHAT IT BROKERS".
- Deviation (rule 6): **`/v2` is OFF (403 + explanation) in broker mode** — the distribution API cannot carry leases, and serving decrypted blobs to any S5 token holder would bypass lease enforcement entirely; documented in serve.md, revisit with S7 identity if a consumer needs it. Ref reads stay open (see checklist note). Existing plaintext blobs in a store that later turns on `--encrypt` stay plaintext (content-addressed no-op) — documented "fresh store for full coverage".
- Tests: keys-handler.test.ts (blind-host in-process over HttpPodStore→app fetch, keyless 423 + ciphertext-on-disk, /api/keys 404-without-authority, metadata-only GET, TTL clamp, ro-identity → read-only lease, enforcement matrix incl. forged-authority lease + fake-clock expiry with re-login hint, /v2 403; browser keyring flow under a fake clock: adoptLogin → bind → write/read → expiry `PodLockedError` → re-login restores). serve.test.ts broker e2e (spawned CLI): banner, `.alias` on disk + no plaintext in blobs, authority dir 0700/file 0600, 401-without-lease → login → lease-header reads (layer tar gunzipped to find the marker), /v2 403, then a keyless reopen of the SAME store: refs 200, plain digest 423, and a full `pushEncryptedRef`/`pullEncryptedRef` round trip through it as a blind host. Gate: lint/build/tsc/test → 46 files / 510 tests green.
- 2026-09-02 (addendum — owner: "encrypting the browser's local OPFS is the entire point"): **EncryptedFS** (`src/sandbox/encrypted-fs.ts`, `encryptedMount` exported from /sandbox) — a ZenFS wrapper filesystem storing file CONTENTS as chunked-AEAD ciphertext on any inner backend (OPFS/IndexedDB/InMemory), keyed by a callback that may throw (keyring lock). Plaintext exists only in the `Async` mixin's in-memory mirror; names/mtimes/(ciphertext) sizes stay visible — filename encryption is future. Landmines (hard-won): zenfs `Inode` structs are Uint8Array views with ACCESSOR fields — spread/rest-destructure yields byte soup, and the VFS `Handle.write` mutates `inode.size` IN PLACE on whatever object `stat` returned, so leaking the live inner struct stamps the PLAINTEXT size into the inner store and truncates the ciphertext (`detach()` every inode you hand out); `StoreFS.write` never updates inode size (the VFS touch does — with the plaintext size, which must be stripped), so EncryptedFS touches the inner with the CIPHERTEXT length itself and treats an explicit size change in touch as O_TRUNC → plaintext resize + re-encrypt. Tests: encrypted-fs.test.ts (4: VFS round trip + ciphertext-at-rest, remount persistence, locked-mount/write refusal, plaintext adoption).
- **Device-wrapped login (ECDH)** in the same addendum: `POST /api/keys/login` accepts `devicePublicKey` (base64 SPKI) → responds `wrappedKeys` (`wrapKeyForDevice`, ephemeral-static ECDH + AES-GCM) with raw KEKs omitted; client `unwrapLoginResult` → NON-EXTRACTABLE AES keys (raw key bytes never exist in page JS); `PodLocker.adoptLease(lease, cryptoKeys)`; `createZenFsPod` authority grew `adopt: {lease, key}` (boot adoption BEFORE the basis pull writes a byte) + `KeyedLoginResult`-returning `login`. Demo: ECDH device keypair persisted in IndexedDB (structured clone), device-wrapped login is the default, workspace uppers ride `encryptedMount`, the pod store encrypts+adopts at boot, and lease renewals re-key the pod keyring. Hardware TPM push recorded in §5.

### S6 — pull-through cache + `artipod replicate`

- [ ] `--cache`: relay miss → upstream fetch (allowlist) → digest-verify → `putBlob` → serve; cached under `<host>/<name>`, pullable via `/v2/`; poisoning test (upstream lies about digest → 502, nothing stored)
- [ ] `artipod replicate <src> <dst>` verb: dir-or-URL sides, anti-entropy body, `mergeHeads` default / `--overwrite` flag, summary output (blobs copied, refs advanced/merged/skipped)
- [ ] Replicate test: temp store → temp store, then live `serve` → live `serve` (spawned, `--port 0`)
- [ ] **Done when**: two `serve` instances converge via `replicate` after divergent writes (LWW winner per sync-demo D8), and a cached upstream image pulls with dockerd while the upstream is unreachable

Worklog:

### e2e (closes the plan)

- [ ] Replay the sync-demo north-star e2e against `artipod serve` (not Next dev)
- [ ] Demo refactor: five route files → one catch-all on `createArtipodApp` (env-var policy preserved); deployed service redeploy is **ask-first** *(moved from S2)*
- [ ] CI job proving both demo build modes (dev + `STATIC_EXPORT=1` export) stay green *(moved from S2)*
- [ ] `README.md` + `docs/README.md` sections; `docs/serve.md` final; `docs/on-disk-layout.md` store + `~/.artipod/ui/<digest>` paragraph
- [ ] Owner publish of core + shim (**ask-first**; the bundled UI rides the same npm publish — no separate artifact step)

## 5. Future (documented only — do not start without re-planning)

- **OIDC identity hook**: `oidcAuth({ issuer, audience })` verifying JWTs against JWKS, returning `Identity` with claims → the S5 shape absorbs it. Dep (`jose` or hand-rolled `node:crypto` JWKS) rides in the shim per V6.
- **LDAP/AD + SAML**: never native. `docs/serve.md` recipe: Dex or Keycloak in front, bridging to the OIDC hook. This is the Harbor-scope trap we are deliberately not falling into.
- **RBAC beyond ro/rw**: small policy file mapping repo-name patterns → role per identity/group claim. Not Harbor projects/quotas.
- **Key rotation / rewrap**: revoking an already-issued key for real (rewrap KEK, not re-encrypt blobs — `docs/encryption.md`); until then V10's layered enforcement is the honest story. Offline device grants (`issueGrant` envelope wrapping) ride the same future.
- **Hardware-backed device keys (owner push, 2026-09-02: use a TPM when available)**: the ECDH device keypair behind device-wrapped `/api/keys` login lives today as a non-extractable WebCrypto key structured-cloned into IndexedDB. Upgrade paths, in order: WebAuthn **PRF extension** (passkey-derived wrapping key — hardware-backed wherever the platform has a secure enclave/TPM, unlock ceremony = biometric/PIN); enclave-resident keys via platform authenticators; serve-side, the authority signing key + KEKs move from `authority.json` into the OS keychain / TPM2. The wire is already shaped for it: login's `devicePublicKey` field doesn't care where the private half lives — no protocol change needed.
- **Continuous mirroring**: `replicate --watch` (interval or event-driven off `refs` changes).
- **TLS**: not in-process; document reverse-proxy/tunnel (Caddy, cloudflared) — browsers only need a secure context off-localhost.
- **Referrers API / artifact extensions**: revisit when a consumer exists.

## 6. Risks & landmines (read before the phase that hits them)

| Risk | Phase | Mitigation |
|---|---|---|
| Next static export silently breaks on the ZenFS struct-minify issue | S2 | The SkipStructChunkMinify plugin must apply in export mode too; grep the exported chunks for `Invalid name for struct field` marker survival as a build assertion |
| `docker` refuses HTTP registries | S3/S4 | Document `insecure-registries` for localhost testing; TLS story is §5 (proxy) |
| Upload sessions in memory lose pushes on restart | S4 | Spec-permitted (client retries); note in docs; TTL + temp-dir cleanup on boot |
| `--publish` write-back and `/v2/` push mutate the same refs with different semantics | S4 | V8 is the rule; `docs/serve.md` table; test covering a `/v2/` push onto a published ref |
| First `serve` has no network → no UI | S2 | Moot since the V6 re-amendment: the UI ships bundled in the npm package (offline-complete); `ARTIPOD_UI_DIR` still serves any local build |
| ~~Pinned UI digest drifts from the published artifact~~ | S2 | Superseded — no remote artifact/pin exists (V6 re-amendment); the analogous skew (UI bundling an older core) is caught by the `ui-buildinfo.json` version-skew warning |
| `--key-ttl` read as hard revocation — it isn't | S5.5 | V10 layered-enforcement paragraph in `docs/serve.md`; rotation/rewrap is the §5 answer; never market the TTL as revoking leaked keys |
| Authority dir (raw KEKs) leaks via backup/snapshot of `~/.artipod` | S5.5 | 0700, separate `--authority` location documented, ask-first before any non-localhost key-issuing bind |
| Broker mode surprises users who assumed E2E | S5.5 | Blind-host vs broker table up front in `docs/serve.md`; startup banner prints "key broker: ON (server can decrypt brokered pods)" |
| Port 2784 collides with something local | S0 | `--port 0` everywhere in tests; banner prints the real URL |
