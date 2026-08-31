# sync demo plan — one repo, and a server folder that lives in your browser

**Status**: Living implementation plan — the implementer updates this file as work proceeds (same rules as `artipod-layer-plan.md` §0)
**Date**: 2026-08-31
**Owner / Implementer**: horner (phase gates self-reviewed)
**Follows**: `artipod-layer-plan.md` (Phases 0–6.6 complete, [#46](https://github.com/mieweb/artipod/pull/46) merged). This plan is the next workstream; it does not reopen ratified decisions from that plan — it builds on them.

## 0. How to work this plan

The working rules, commit conventions, phase-gate ritual (`docs(plan): sync phase X gate`), verification rule (paste command + result into the worklog), and deviation rule are **identical to `artipod-layer-plan.md` §0** — read that first if you haven't. Extra rules for this plan:

- Phases strictly A → F. A is a history operation — do it on clones, never on the working checkouts, and get owner go-ahead before pushing the merge.
- After Phase A, the app lives at `examples/artipod-sync/` **in this repo**; "app half" PRs stop being cross-repo.
- `npx tsc --noEmit -p tsconfig.json` before every gate (CI can't see test-file type errors — learned in 6.6).

### Ask-first list (owner sign-off required)

- Pushing the Phase A history merge to `mieweb/artipod` `main`, and **archiving `horner/artipod-sync`** (owner clicks Archive; add a final README pointer commit there first).
- Anything touching the deployed service (`deploy/artipod-sync.service` — its `WorkingDirectory` changes with the move) and prod env (`ARTIPOD_STORE_DIR`, new `ARTIPOD_PUBLISH_ROOTS`).
- Publishing any `@artipod/core` release that first exposes the `/server` subpath.

### Phase tracker (keep current)

| Phase | Branch | Status | PR |
|---|---|---|---|
| A — repo consolidation (move artipod-sync in, keep history) | `sync-a-move` | done | [#47](https://github.com/mieweb/artipod/pull/47) |
| B — `@artipod/core/server` subpath (the heft leaves the app) | `sync-b-server` | done | [#48](https://github.com/mieweb/artipod/pull/48) |
| C — folder → artipod publish (per-file layers) | `sync-c-publish` | done | [#49](https://github.com/mieweb/artipod/pull/49) |
| D — browser opens a basis lazily; fetch-on-read | `sync-d-lazy-open` | done | [#50](https://github.com/mieweb/artipod/pull/50) |
| E — write-back: auto-push layers, server materializes | `sync-e-writeback` | done | [#51](https://github.com/mieweb/artipod/pull/51) |
| F — CRDT convergence: per-file LWW merge | `sync-f-crdt` | todo | |

## 1. Goal — the demo scenario (north star)

> Browse to the server. Pick a public artipod (a folder the server published) as a basis. The client opens a **new layer on top of it**. In browser bash, `find` sees every file but **nothing has transferred**. `cat README.md` fetches that file and caches it. `echo "hi" > testfile.txt` uploads a new layer; `rm old.txt` uploads a whiteout. Files not yet local are visibly marked. Meanwhile someone edits the folder on the server, republishes, and both sides converge — **the sync layer is formally a CRDT**.

Success = a scripted e2e that walks that exact paragraph, plus a live run against the example app.

### Decisions ratified 2026-08-31 (owner-answered; do not relitigate)

| # | Decision |
|---|---|
| D1 | Retire `horner/artipod-sync`; import into `mieweb/artipod` via **git-filter-repo path-rewrite merge** (full per-file history). Old repo archived as the historical record. |
| D2 | The example app stays **thin**; the heft goes into **`@artipod/core/server`**, a node-only subpath export (same pattern as `/docker`: `browser` field stubs, values never reachable from browser bundles). No new npm package — the single-package convention from layer-plan Decision #2 holds. |
| D3 | **Bidirectional from the start** (browser ⇄ server folder). |
| D4 | Folder freshness v1 = **manual publish** (API/CLI re-snapshot). Watcher/snapshot-on-pull are stretch. |
| D5 | Published-folder layer granularity = **one layer per file** (default). This keeps layer-plan Decision #12 intact — the unit of hydration is still the whole layer; the *publisher* chooses granularity, so `cat file` fetches exactly `file`. `--group <glob>` opts into coarser layers (reuses 6.6 `layerGroups`). Regroup/compact before exporting to a real registry (a manifest with thousands of layers is legal but rude). |
| D6 | Read semantics for a demo-opened basis = **fetch-on-read, unlimited**: any content read transparently hydrates its layer (interactive lane). `stat`/`ls`/`find` remain zero-fetch from indexes. The 6.6 fail-fast default is now a **mode** — `hydration.onDemand: 'fail' \| 'fetch'` — and existing pulls keep `'fail'` so the pinned zero-fetch grep test stands. |
| D7 | Write-back cadence = **debounced auto-push**: quiet window (~2 s) after `fs:changed` → diff-layer snapshot → push. `rm` rides the same path as a whiteout. Explicit `artipod push` still works. |
| D8 | Convergence = **per-file LWW merge, history kept**: blobs + manifests form a G-Set (content-addressed — never conflicts); a ref head advances by a deterministic per-path merge keyed by `(mtime, actor)`; losing layers stay reachable through parent manifests (recoverable via snapshot history). |
| D9 | _(ratified 2026-08-31)_ **Per-path mergers are pluggable**: `mergeHeads` takes `mergers: { '<glob>': (a, b) => bytes }` — default stays LWW; a matched path resolves by *content merge* instead (the result becomes a new layer). Motivating case: Yjs documents (mieweb/yorm) — `Y.mergeUpdates([a, b])` is a lossless join where LWW would drop a side among artipod-only (offline) replicas. Core stays CRDT-library-free: apps inject the resolver; the contract (deterministic, commutative, associative, idempotent) is property-tested against every registered merger. Composition with live Yjs sync is documented in [docs/sync.md](docs/sync.md). |

## 2. What already exists (build on it, don't rebuild it)

| Need | Have (phase) |
|---|---|
| Digest-addressed store, tar/gzip, whiteouts preserved in merges | `src/oci/` store/tar/view (P4) |
| Production tar writer (PAX, whiteouts), diff-layer snapshots, `commit --layer-group` | `src/oci/snapshot.ts` `writeTar`, `SnapshotManager` (P5, 6.6) |
| Blob/ref anti-entropy sync, budgets, `storeTransport`, `materializeImage` | `src/manager/sync.ts` (P6) |
| Server store on a plain directory (skopeo-inspectable) | `OciLayoutPodStore` (P6) |
| HTTP sync client **with Range** (`getBlobRange`) | `HttpPodStore` (P6, 6.6) |
| Index-level pull, placeholders, hydrate/dehydrate, `/proc/hydration`, lanes, resumable fetch | `src/manager/hydration.ts` `Hydrator`, `BandwidthScheduler`, `fetchBlobResumable` (6.6) |
| Dehydrated read signal | `OciViewFS` throws `DehydratedError` (6.6) |
| Per-layer published indexes (`ANNOTATION_LAYER_INDEX`) → zero-fetch `find` | 6.6 commit + pull |
| CoW upper on a read-only view ("new layer on top") | zenfs realizer `cow` (P3) + `OciViewFS` mounts |
| Events for "something changed" (debounce source) | `PodEvents` `fs:changed` per live exec (P2) |
| Session/exec hosting, git proxy patterns to graduate | `examples/artipod-sync/lib/server/`, `/api/pods` route (P6 app half) |

The genuinely new pieces: **directory publisher/materializer**, **fetch-on-read mode**, **auto-push loop**, **LWW ref merge**, and the **HTTP handler factory** so the app's API routes become one-liners.

## 3. Design

### 3.1 Phase A — repo consolidation

Target layout: `examples/artipod-sync/` beside `examples/basic` and `examples/mcp-server` — it is *the* hosted example implementation.

History mechanics (all on throwaway clones; `mieweb/artipod` never sees a force-push):

```bash
brew install git-filter-repo                      # not currently installed
git clone https://github.com/horner/artipod-sync.git /tmp/sync-import
cd /tmp/sync-import
git filter-repo \
  --path screenshot.png --path screenshot_final.png \
  --path screenshot_help.png --path screenshot_help_2.png \
  --invert-paths \
  --to-subdirectory-filter examples/artipod-sync
cd <artipod clone> && git checkout -b sync-a-move
git remote add sync-import /tmp/sync-import && git fetch sync-import
git merge --allow-unrelated-histories sync-import/main
git remote remove sync-import
```

- Screenshots are the only paths dropped from imported history (binary junk). Everything else imports as-is; `git log --follow examples/artipod-sync/app/page.tsx` must show the pre-move history.
- **Tidy commit** (same PR, separate commit): move `examples/artipod-sync/just-bash-plan.md` → `attic/just-bash-plan.md` (superseded by `artipod-layer-plan.md`) and `examples/artipod-sync/.attic/*` → `attic/artipod-sync/`; fold anything worth keeping from the imported `.github/copilot-instructions.md` into this repo's, then delete the nested copy (nested `.github` is inert anyway); delete `components/wtf.md` (historical sketch, superseded by P6); update `examples/README.md` + root `README.md` to point at the app.
- **Wiring commit**: `package.json` dep `"@artipod/core": "file:../artipod"` → `"file:../.."` (`.npmrc install-links=true` must survive the move — the symlink/zenfs-singleton gotcha from P6 is recorded there); fix `deploy/artipod-sync.service` paths (ask-first before deploying); sibling-checkout references in docs (`../artipod-sync`) → `examples/artipod-sync`.
- **CI**: add an `example-app` job to `nodejs.yml` — `working-directory: examples/artipod-sync`, `npm ci && npm run lint && npx vitest run && npm run build`. Root job is untouched (the example is `private: true`, invisible to `files`/publish).
- Old repo: final commit adds a README banner "moved to mieweb/artipod → examples/artipod-sync"; owner archives it. Open issues worth keeping (e.g. #1 OCI design) are already linked from plan docs — no migration needed.

### 3.2 Phase B — `@artipod/core/server`

New subpath `./server` → `dist/server/index.js`, listed in the `browser` field as `false` (exactly like `/docker`). Node-only: may import `node:fs`, `node:path`. Rule of thumb from layer-plan §6 note 2 applies: *if a second server app would copy-paste it, it's package; if it's one deployment's policy, it's app.*

```ts
// @artipod/core/server
export function createPodStoreHandler(opts: {
  store: PodStore;                       // usually OciLayoutPodStore
  auth?: (req: Request) => boolean | Promise<boolean>;
  onRefPut?: (ref: string, digest: Digest) => void | Promise<void>;  // Phase E hook
}): (req: Request, path: string[]) => Promise<Response>;
// fetch-style: Next route.ts, Hono, or node http adapter wire it in ~3 lines.
// Serves blobs (GET/HEAD/PUT incl. Range for fetchBlobResumable), refs (GET/PUT/LIST).

export function createGitProxyHandler(opts: { allowlist: string[] }): (req: Request, path: string[]) => Promise<Response>;
export function createExecSessionHandler(opts: { host: PodSessionHost; auth?: …; limits?: … }): (req: Request) => Promise<Response>;
export function createRegistryRelayHandler(opts: { allowedHosts: Iterable<string> }): (req: Request, path: string[]) => Promise<Response>;
// ^ small deviation (rule 6): the /api/oci relay was copy-paste generic too, so it graduated with the rest.

export { publishDirectory, materializeRef } from './folder.js';   // Phase C/E
```

- Port the *generic* halves of `examples/artipod-sync/lib/server/exec-sessions.ts` + `git-proxy.ts` and the `/api/pods` route body into these factories **with their tests**; the app keeps only policy numbers (TTLs, rate limits, allowlist contents) passed as options. The Range branch moves in here (today only the client half exists in `HttpPodStore`; the route grows `206` support).
- The four Next routes in the example shrink to: build options from env → delegate. Demo stays auth-open; `auth` hook exists so a real deployment isn't a fork.
- vitest: node-only suite lives beside the sources like `/docker`'s; browser-bundle guard test asserts `import '@artipod/core'` pulls nothing from `dist/server/`.

### 3.3 Phase C — folder → artipod (`publishDirectory`)

```ts
publishDirectory(store: PodStore, dir: string, ref: string, opts?: {
  actor?: string;              // LWW identity; default `server:<hostname>`
  group?: string[];            // globs → coarser layers (6.6 layerGroups reuse)
  ignore?: string[];           // default: node_modules/**, .git/**, .artipod/**
}): Promise<{ manifestDigest: Digest; layers: number; reusedLayers: number; bytes: number }>
```

- Walk `dir` (node fs). **Per file: one tar entry → one gzipped layer blob** (D5), plus its published index artifact (`ANNOTATION_LAYER_INDEX`) so pulls are index-level. Layer annotations: `org.artipod.hydration: lazy`, `org.artipod.path`, `org.artipod.mtime` (file mtime, ms), `org.artipod.actor` — the last two are the LWW register metadata (D8).
- **Incremental republish is free via CAS**: unchanged file → same tar bytes → same digest → `hasBlob` short-circuits; only changed files produce new blobs. A republish always writes a new manifest + config (diff_ids ordered by path — canonical ordering matters for D8 determinism) and advances the ref. Manifest annotation `org.artipod.parents: [prev manifest digest]` records the DAG edge.
- Determinism requirement (test-pinned): publishing the same tree twice yields byte-identical layer blobs (fixed tar mtime? **no** — mtime is the LWW clock, so tar entry mtime = file mtime; determinism holds because unchanged files have unchanged mtimes; gzip must run with fixed mtime=0 header).
- Symlinks: v1 skip + warn (recorded limitation). Empty dirs: single dir-entry layer only if needed; else directories are implied by indexes.
- Refs namespace: `folder/<name>:latest`. Example app: `POST /api/pods/publish {dir, ref}` guarded by `ARTIPOD_PUBLISH_ROOTS` allowlist (resolve + prefix check — no `..`/symlink escapes), plus `scripts/publish.mjs` for CLI use (`npm run publish:folder -- ./docs folder/docs`).

### 3.4 Phase D — open a basis lazily; fetch-on-read

- New pod verb `artipod open <ref>` (+ `sync.basis` pod option + a picker in the example's start screen listing `GET /api/pods/refs`): `Hydrator.pullIndex(ref)` (metadata only) → mount `OciViewFS` at `/basis/<name>` → **CoW upper over it mounted rw at the workspace** — that *is* "the client opens a new layer on top" (P3 `cow` + 6.6 placeholders, already composable).
- `hydration.onDemand: 'fetch'` (D6): the pod's fs boundary catches `DehydratedError`, calls `hydrator.hydrate(ref, exactPath)` on the **interactive** lane, retries the read. Per-file layers ⇒ the fetch is exactly that file. `find`/`ls`/`stat` keep serving from indexes — zero transfer (pin with the existing zero-fetch test pattern: `find` then assert `fetch:start` never fired).
- just-bash constraint (recorded in repo memory): reads are async promises inside the interpreter, so blocking-until-hydrated works naturally; but **cat discards fs error text**, so failure hints must ride events/UI, not shell stderr — with `'fetch'` mode the happy path never errors.
- "Show that the file is not local yet": FileTree renders a cloud badge from `/proc/hydration` + flips on `fetch:done`; bash gets `artipod status [path…]` printing local/remote per file. (An `ls` column would mean patching just-bash — out of scope, upstream is read-only.)
- Budget note: D6 says unlimited, so no per-exec byte cap; `BandwidthScheduler` lanes still order transfers, and `/proc/hydration` + the console banner surface what's flowing.

### 3.5 Phase E — write-back

- Browser: subscribe `fs:changed` → 2 s quiet window → overlay-diff head (upper files → appended per-file layers, journal deletes → one whiteout layer) → `syncRef` push **to the same ref as a fast-forward with a parents link** — _deviation (rule 6) from the earlier `folder/docs@<actor>` sketch: per-actor refs would drag Phase F's cross-ref winner-picking into E; same-ref + parents DAG keeps E demoable and F adds merge-on-non-descendant_. `skipIfClean` avoids empty pushes; anti-entropy makes redundant pushes no-ops.
- Server: `createPodStoreHandler`'s `onRefPut` fires → `materializeRef(store, ref, dir)`: compute per-path winners (same merge fn as F), write changed files into the real folder, apply whiteouts as deletes. **Safety invariants** (test-pinned): resolved target must stay under `dir` (reject `..`, absolute, and symlink-traversal escapes); never follow existing symlinks when writing; materialize only inside `ARTIPOD_PUBLISH_ROOTS`.
- **Loop prevention**: materialize sets file mtimes from layer metadata, so the next `publishDirectory` reproduces identical blobs → CAS dedup → no new layers → no ping-pong. Actor annotations make any residual echo visible in the DAG.

### 3.6 Phase F — CRDT convergence (per-file LWW)

Formal shape: pod state = join-semilattice of
1. **Blob set** — G-Set under union (content-addressed; commutative/associative/idempotent trivially),
2. **Per-ref head** — a map `path → LWW-Register` with timestamp `(mtime, actor)` (actor = total-order tiebreak).

`mergeHeads(store, refA, refB) → manifest`: walk both layer chains to the common ancestor (via `org.artipod.parents`), build the per-path winner set, emit a merged manifest that **references the winning existing layers** (no byte copying), `parents: [A, B]`. Canonical path sort ⇒ same inputs in any order produce the **same manifest digest** — that digest equality is the convergence test. Losers stay reachable through parents (D8: history kept; `artipod snapshot`/`image mount` recovers them).

- Wire it: server merges on push when the incoming head isn't a descendant of the current one; browser merges on pull the same way. Fast-forward stays fast-forward.
- **Pluggable per-path mergers (D9)**: `mergeHeads(store, refA, refB, { mergers })` — the first glob matching a conflicting path resolves it by **content merge**: `resolve(bytesA, bytesB) → bytes`, wrapped into a NEW per-file layer (mtime = max of inputs, actor `merge:<a>+<b>`, both parents recorded). Unmatched paths keep zero-copy LWW. The resolver contract is the join-semilattice contract — deterministic, commutative, associative, idempotent — and the digest-equality property tests run parameterized over every registered merger (core tests use a toy deterministic merger, e.g. sorted-line set union; **no yjs dependency in core** — apps inject `(a, b) => Y.mergeUpdates([a, b])` for `**/*.ydoc`, see docs/sync.md).
- Deletion semantics: a whiteout is just a path entry whose winner may be "deleted at (mtime, actor)" — rm vs concurrent edit resolves by the same clock. Content mergers see only file-vs-file conflicts; file-vs-whiteout stays LWW (a CRDT doc "deleted" on one side is a domain decision, not a byte merge).
- Tests (scripted, no AI per layer-plan Decision #5): commutativity (`merge(A,B) ≡ merge(B,A)` digest-equal), idempotence, associativity across three actors — for LWW **and** for a registered content merger; e2e: browser edits `a.txt` while server republishes `b.txt` → both converge with both changes; both edit `a.txt` → newer `(mtime, actor)` wins everywhere, loser recoverable; both edit `notes.union` under a union merger → merged content contains both lines.
- Demo polish gate: run the §1 paragraph live against the example app and record it in the worklog.

### 3.7 Security notes (OWASP-adjacent, all test-pinned)

- Path traversal: `materializeRef` + publish-root allowlist checks (3.5) — resolve-then-prefix-compare, no symlink following.
- The handler factories take an `auth` hook; the demo ships open like today's routes but a deployment can require bearer without forking.
- Publish ignores `node_modules/.git/.artipod` by default and the docs warn about secrets in published folders (`ignore` globs are the mechanism; a `.artipodignore` file is stretch).
- Encrypted pods: `pushEncryptedRef` (6.5) already covers the relay case; folder publish of an *encrypted* pod is out of scope v1 (folders on disk are plaintext by definition — note in docs).

## 4. Phases — checklists

### Phase A — repo consolidation (`sync-a-move`)
- [x] Owner go-ahead on the merge push + archive plan (ask-first) — merged 2026-08-31 as merge commit 6f0dedf
- [x] filter-repo import per §3.1; `git log --follow` shows pre-move history for `app/page.tsx` and `lib/server/exec-sessions.ts`
- [x] Tidy commit (attic moves, nested `.github` folded, READMEs)
- [x] Wiring commit: `file:../..` + `.npmrc` intact; `npm ci && npm run build && npx vitest run` green **inside `examples/artipod-sync`**
- [x] CI `example-app` job green on the PR
- [x] Root suite untouched: `npm test` green, package `files`/exports unchanged
- [x] horner/artipod-sync: pointer README pushed; owner archives
- **Done when**: both CI jobs green on `main`; old repo archived; a fresh `git clone` + documented steps boot the example against `@artipod/core` from the repo root.
- Worklog:
  - 2026-08-31 — brew wedged on an unrelated untrusted tap; installed filter-repo via `pip install --user git-filter-repo`. Rewrote 43 commits (`--to-subdirectory-filter examples/artipod-sync`, 4 screenshots dropped) on a `/tmp` clone; merged `--allow-unrelated-histories`. Verify: `git log --follow --oneline -- examples/artipod-sync/app/page.tsx | wc -l` → 15.
  - 2026-08-31 — stale lockfile entry resolved `file:../artipod` against the new location (→ `examples/artipod/`); fixed with explicit `npm install @artipod/core@file:../..` (rewrites just that entry, keeps the rest pinned).
  - 2026-08-31 — **nesting gotcha**: the app never had an ESLint config, so at the old location `next lint`/`next build` found nothing up the tree and linted as a no-op; nested under the core repo the cascade found `.eslintrc.cjs` and `next build` died on an unknown `react-hooks` rule. Added `.eslintrc.json` `root:true` + `next/core-web-vitals`; real lint then caught 2 `react/no-unescaped-entities` errors in page.tsx — fixed.
  - 2026-08-31 — verify: example `npm run lint` 0 errors, `npx vitest run` 11/11, `npm run build` green; root `npx vitest run` 373/373, lint 0. PR #47 opened (merge-commit warning in title block).
  - 2026-08-31 — CI: first `example-app` run failed — `npm ci` in the app packs the `file:../..` dep, whose `prepare` runs `tsc` in the **repo root** where devDeps weren't installed (TS2688 no @types/node). Fix: job installs core deps first (`npm ci` at `working-directory: .`). Run 33360200267: all 3 jobs pass (`gh pr checks 47` exit 0, unpiped).
  - 2026-08-31 — gate: #47 merged with a merge commit (6f0dedf); pointer README pushed to horner/artipod-sync main and repo archived (`gh repo view -q .isArchived` → true). Sample-site redeploy from the new path stays an open owner action (deploy checklist in the unit file header).

### Phase B — server subpath (`sync-b-server`)
- [x] `./server` export + `browser:false` stubs; guard test that browser entries never reach `dist/server`
- [x] `createPodStoreHandler` (blobs GET/HEAD/PUT + **Range 206**, refs GET/PUT/LIST, `auth`, `onRefPut`) + ported tests
- [x] `createGitProxyHandler` / `createExecSessionHandler` graduate with their suites; app keeps policy numbers only
- [x] Example routes collapse to option-building one-liners; live smoke: push/pull round-trip + Range resume against the app
- **Done when**: `examples/artipod-sync/lib/server/` contains no generic logic; all previous route behaviors covered by package tests; example e2e (northStar-style) still green.
- Worklog:
  - 2026-08-31 — src/server/: common (PathHandler, AuthHook, bearerAuth — token read per request), pod-store-handler (HttpPodStore wire; Range `bytes=N-` → 206 + Content-Range, past-end → 416, other shapes → 200-full which the client already handles; onRefPut fires after successful ref PUT), git-proxy (pure fns moved verbatim + handler w/ injectable fetchFn), exec-handler (execInSession takes the host as an arg now; handler adds auth/JSON edges), registry-relay (deviation, rule 6: /api/oci was generic — graduated too). 25 tests incl. browser-guard (package.json contract + src-wide import scan).
  - 2026-08-31 — ported 429 busy-guard test raced on a fresh host (the app suite was masked by warm module caches): both execs entered the async session-creation path. Fix: warm the session first so contention is on the busy flag. Deterministic.
  - 2026-08-31 — app: 4 routes → option-building one-liners; lib/server/ deleted; tests/routes.test.ts pins deployment wiring (exec + EXEC_API_TOKEN at request time, ARTIPOD_STORE_DIR, OCI deny-all). Route tests needed vitest include `tests/**`.
  - 2026-08-31 — verify: root `npx tsc --noEmit` clean, 398 tests, lint 0, build 0. App: 4 tests, lint 0, `next build` 0. Live smoke vs `next start` on :3599 (tmp store): PUT blob 201 → HEAD 200 → GET 200 → GET Range bytes=6- → **206** with the byte-6 slice → PUT ref 201 (manifest-first held) → GET refs lists it → blob present under /tmp/smoke-store/blobs/sha256/. Terminal-simplifier gotcha: a dropped `cd` made npx offer to download next@16 — use `npm --prefix` for app commands.

### Phase C — folder publish (`sync-c-publish`)
- [x] `publishDirectory` per §3.3: per-file layers + per-layer published indexes + LWW annotations + parents chain
- [x] Determinism + CAS-reuse tests (republish unchanged tree ⇒ 0 new blobs; touch one file ⇒ 1 new layer)
- [x] `--group` globs; ignore defaults; symlink skip+warn
- [x] Example: `POST /api/pods/publish` behind `ARTIPOD_PUBLISH_ROOTS` + `scripts/publish.mjs`
- [x] Live: publish a real docs folder, `skopeo inspect` the layout store shows per-file layers
- **Done when**: publish → browser `artipod image pull --index` lists the full tree with zero layer fetches (existing index-pull path).
- Worklog:
  - 2026-08-31 — src/server/folder.ts `publishDirectory(store, dir, ref, {actor, group, ignore})`: sorted walk (canonical order = deterministic diff_ids), one tar+gzip layer per file (or per `group` glob, first match wins), per-layer published index artifacts, annotations lazy/path/mtime/actor (`ANNOTATION_MTIME`+`ANNOTATION_ACTOR` = the D8 LWW clock), `org.artipod.parents` on the manifest. **Unchanged-tree republish is a full no-op** (same layers+config as head ⇒ head returned, ref untouched — otherwise every cron republish would grow the DAG with parents-only manifests). CAS reuse via hasBlob short-circuit. `ImageManifest` gained optional `annotations`. Symlinks/empty dirs skip+warn; OciViewFS already synthesizes implicit parent dirs, so no skeleton layer needed.
  - 2026-08-31 — determinism note: tar entry mtime = file mtime (it IS the LWW clock); gzip determinism rides CompressionStream/zlib MTIME=0 (fflate fallback would stamp — unreachable on node ≥18, commented).
  - 2026-08-31 — folder.test.ts (4): annotations/per-file layers; no-op republish + one-touch ⇒ 1 new layer + parents link; groups/ignores/symlink warn; **done-when e2e**: publish → pod w/ `sync.remote`+`hydration` → `artipod image pull folder/demo:latest --index` → mount + `find` lists all files while the WAN meter shows ZERO layer-blob reads. Gotchas: index entry paths are pod-absolute (`/docs/a.md`); verb order is `image pull <ref> --index`; the pull verb needs the `hydration` pod option.
  - 2026-08-31 — app: lib/pods-store.ts singleton shared by `[...path]` + new `POST /api/pods/publish` (realpath + prefix check under `ARTIPOD_PUBLISH_ROOTS`, empty = disabled; ref regex); `scripts/publish.mjs` + `npm run publish:folder`. tests/routes.test.ts → 6 (publish inside/outside roots, disabled-by-default; store dir pinned at module scope before route imports — the singleton reads env once).
  - 2026-08-31 — verify: root 402 tests / build 0 / tsc clean; app 6 tests / lint 0 / build 0. Live: published repo `docs/` → "7 layers (0 reused, 22527 new bytes)", immediate republish → "unchanged"; store = `oci-layout` + `index.json` (ref annotated) + 16 blobs (7 layers + 7 indexes + config + manifest). (skopeo not installed locally — layout verified with ls + index.json inspection; the format IS the skopeo dir format.) npm gotcha: `npm --prefix <dir> exec` does NOT chdir (ran the root vitest config) — use `npm --prefix <dir> run`.

### Phase D — lazy open + fetch-on-read (`sync-d-lazy-open`)
- [x] `artipod open <ref>` verb + `sync.basis` option: index pull → lazy view → CoW upper rw mount
- [x] `hydration.onDemand: 'fetch'` mode (default remains `'fail'`; zero-fetch grep test still passes)
- [x] Fetch-on-read at the fs boundary: `DehydratedError` → interactive-lane hydrate → retried read; per-file layer = per-file fetch (pin with fetch counters)
- [x] `find` zero-transfer test; `cat` transfers exactly one blob test
- [x] FileTree cloud badges via `/proc/hydration` + `fetch:*`; `artipod files` per-path local/remote
- [x] Example start screen: ref picker from `GET /api/pods/refs`
- **Done when**: §1 sentences 1–4 pass scripted (open basis, find=0 fetches, cat=1 fetch, cached re-read=0).
- Worklog:
  - 2026-08-31 — seam decision: fetch-on-read lives INSIDE `OciViewFS` — `read()` is async-over-sync, so an optional `onDehydrated(path, ordinal)` hook awaits the layer bytes and patches `this.layerBytes[ordinal]` **in place** (no remount, every consumer covered: just-bash cat, file tools, Monaco, tree). Sync reads keep failing fast by construction. `buildOciView` extracted so overlays can use the view as a CoW lower without mounting.
  - 2026-08-31 — hydrator: `onDemand: 'fail'|'fetch'` option; `fetchLayer` extracted from `hydrate()` (per-layer fetch/verify/persist/state-flip, no remount — `hydrate()` keeps its remount for the explicit verb); `dehydratedPaths(ref)` (winning-layer placeholder files); `openOverlay(ref, at)` = lazy view lower + `CopyOnWrite` upper (InMemory v1 — durability arrives with Phase E push), tracked in `hydrator.overlays` for E's diffing.
  - 2026-08-31 — verbs: `artipod open <ref> [path]` (pulls index if absent, default `/open/<slug>`) and `artipod files [<ref>]` (STATE/SIZE/PATH; ref optional with one overlay). **Deviation (rule 6): plan said `artipod status` — that verb was already taken by 6.5's keyring status; renamed to `files`.** Pod: `sync.basis {ref, at?}` opens at boot (offline-tolerant warn), default cwd follows the overlay, `pod.basis` exposed.
  - 2026-08-31 — openPod.spec (2): the §1 script — open → `find` = 0 layer reads → `cat` = exactly 1 → re-read = 0 (cached) → `files` ledger local/remote → overlay writes (`echo > new`, basis overwrite) → boot-basis cwd → `'fail'` pod still EREMOTEs with 0 fetches. Passed first run. 404 root tests total.
  - 2026-08-31 — app: start screen picker (refs from `/api/pods/refs`, blank option, auto-skip when none), pod boots with `basis`+`onDemand:'fetch'`+`defaultRef`, FileTree `roots` prop + ☁︎ badges (`getDehydratedPaths` → overlay-prefixed, refreshed on `fetch:done`/`fs:changed`). **next.config gotcha: `@artipod/core` was never in `serverComponentsExternalPackages` (only its deps were) — webpack bundled `/server` for the publish route and its export analysis broke (`Attempted import error: publishDirectory`); externalizing the package fixes it and matches the existing ZenFS reasoning.**
  - 2026-08-31 — live (browser at :3599, docs/ published): picker → click → terminal at `/open/folder_docs_latest`, `ls` lists 7 files zero-fetch, `artipod files` all `remote`, `head -2 browser.md` prints content and flips it `local` (console.md stays `remote`), `echo demo-note > note.txt && cat` works in the overlay. Screenshots in PR.

### Phase E — write-back (`sync-e-writeback`)
- [x] Debounced auto-push: `fs:changed` → quiet window → diff snapshot (whiteouts incl.) → `syncRef` push; `skipIfClean`; explicit `artipod push` unchanged
- [x] `materializeRef` + `onRefPut` wiring; traversal/symlink safety tests
- [x] Loop prevention: mtime round-trip ⇒ republish is a CAS no-op (test)
- [x] Live: `echo hi > testfile.txt` in the browser appears in the server folder; `rm` deletes it; server-side edit + publish appears in the browser
- **Done when**: §1 sentences 5–6 pass scripted both directions.
- Worklog:
  - 2026-08-31 — diff source decision: NOT SnapshotManager (it walks pod roots vs its own chain) — the CoW **upper IS the diff**: zenfs CopyOnWrite has a deletion `Journal` (reusable via options) and the upper fs mounts at `/.artipod/upper/<ref>` for a plain promises-API walk. `openOverlay` now reuses upper+journal across re-opens (basis refresh keeps local changes), and `overlayDeletions()` stamps first-seen deletion times (the whiteout LWW clock — the journal has no timestamps).
  - 2026-08-31 — head shape: new head = basis layers verbatim (group layers + other clients' laziness preserved) + one per-file layer per upper file + one whiteout layer, all annotated `org.artipod.overlay: <actor>` so the next push replaces them wholesale (idempotent; unchanged upper ⇒ byte-identical head ⇒ skip). `buildFileLayer` extracted to src/oci/file-layer.ts — publishDirectory and the overlay push share it. Push = local head build + `syncRef` (remote already holds basis blobs → only new layers move; local placeholders never need fetching — anti-entropy only reads local blobs the remote LACKS).
  - 2026-08-31 — materializeRef: merged view (whiteouts applied) → real folder; deletions = parent-head paths absent from the new head; mtimes from tar entries (second-granularity) → `publishDirectory` after materialize reuses EVERY layer blob (pinned) and the canonical republish after that is a full no-op. Safety pinned: `../` refused, targets prefix-checked under realpath(dir), squatting symlinks replaced never followed.
  - 2026-08-31 — pod wiring: `sync.actor` (app persists `browser:<uuid8>` in localStorage), `sync.autoPush` (default ON w/ basis+remote, 2 s debounce, queued re-push, dispose clears), `pod.pushBasis()`, `sync:push` event; push failures console.warn (a silent catch cost an hour of live debugging). `artipod open` now refreshes when the remote head moved; `pullIndex` keeps layers hydrated when their twin is already local. App: publish-map.json (ref→dir beside the store) written by /api/pods/publish; pods route `onRefPut` re-checks roots then materializes (best-effort, warn on failure).
  - 2026-08-31 — writebackPod.spec (4) all first-run green: echo→layer+parents, rm→whiteout (origin blob kept), materialize+CAS-no-op republish, server-edit→refresh (upper survives), debounce event, traversal/symlink pins. Root 408, app 7 (incl. ref-PUT-resurrects-deleted-file wiring test).
  - 2026-08-31 — **gotcha (cost the live session an hour): Next's webpack cache serves a STALE copied `file:` package** — `npm install` refreshed node_modules/@artipod/core but `.next/cache` kept old module bytecode (browser pod had no `pushBasis`, D-era overlay shape). `rm -rf .next` before rebuild after ANY core refresh. Also: Playwright-driven pushes log `net::ERR_ABORTED` bursts when an automation snippet ends mid-flight — the pushes complete anyway (files on disk); judge by effects, not the request log.
  - 2026-08-31 — LIVE both directions (:3599, /tmp/demo-folder published via route): browser `echo hello-from-browser > sync-note.md && rm browser.md` → ~2 s → sync-note.md ON DISK, browser.md DELETED on disk; `echo server-edit v2 >> README.md` + republish (3 layers, 2 reused) → browser re-open pulls 2528 bytes of metadata → `tail -1 README.md` = server-edit v2, sync-note.md intact.

### Phase F — CRDT merge (`sync-f-crdt`)
- [ ] `mergeHeads` per §3.6 (ancestor walk, per-path LWW, canonical ordering, parents=[A,B])
- [ ] `mergers` option (D9): glob → content resolver, merged bytes become a new layer; property tests parameterized over LWW + a toy union merger (no yjs in core)
- [ ] docs/sync.md: the sync model + "Composing with Yjs (YORM)" (when LWW is safe, when the merger hook is needed, tempo/origin guidance)
- [ ] Property tests: commutative/idempotent/associative by manifest digest
- [ ] Server merge-on-push (non-descendant heads), browser merge-on-pull; fast-forward preserved
- [ ] Concurrent-edit e2e (disjoint files → union; same file → deterministic winner; loser recoverable via parent manifest mount)
- [ ] Demo polish: run the full §1 paragraph live; record in worklog; update `docs/` status banners + README
- **Done when**: full scenario green scripted + live; docs updated in the same PR (docs-as-spec).
- Worklog:

## 5. Risks

| Risk | Mitigation |
|---|---|
| filter-repo mistake pollutes mieweb/artipod history | operate on throwaway clones; owner reviews the merge PR's file list + `log --follow` spot-checks before push; never force-push main |
| Per-file layers explode manifest size on big folders (node_modules-scale) | default ignores; `--group` for coarse grouping; documented "regroup/compact before registry export"; manifest is JSON — thousands of entries is fine for the demo scale |
| mtime as LWW clock: skew/equal stamps | actor-id total-order tiebreak; ms resolution; documented (this is LWW, not vector clocks — losers are *kept*, so skew miscalls are recoverable, D8) |
| Fetch-on-read unlimited + `grep -r` pulls the world | lanes keep UI responsive; `/proc/hydration` + console show transfer; D6 explicitly accepts it for the demo; `'fail'` mode remains for agents |
| Materialize writes outside the folder (traversal/symlink) | §3.5 invariants test-pinned before any live wiring |
| Auto-push ping-pong browser⇄server | mtime round-trip + CAS dedup (§3.5); actor annotations make echoes auditable |
| Next bundling regressions after the move (`file:` dep semantics) | `.npmrc install-links=true` survives; P6 gotcha recorded; CI example-app job catches it |

## 6. Open items (small, decide at impl time — note in worklog)

- `artipod open` UX: replace the workspace cwd vs mount beside it (`/basis/<name>` + cd) — lean toward mount-beside + cd, it's less magical.
- Browser actor id: `crypto.randomUUID()` persisted in localStorage vs derived from storage backend id.
- `POST /api/pods/publish` in the demo UI (button) vs CLI-only for v1.
- Whether `folder/<name>` refs should appear in the existing StorageSettings UI or a new start screen (lean: start screen, it's the demo's front door).
