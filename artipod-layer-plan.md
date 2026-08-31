# artipod layer plan — making `artipod/` the single source of truth

**Status**: Living implementation plan — the implementer updates this file as work proceeds (see §0)
**Date**: 2026-08-30
**Owner / Implementer**: horner (phase gates self-reviewed)
**Supersedes / resolves**:
- `just-bash-plan.md` §8 Q5 (package home) → **decided: fold into `mieweb/artipod`**
- `plan-artipodSync.prompt.md` §5 (Git + LFS/CAS sync model) → **replaced by OCI layers** ([horner/artipod-sync#1](https://github.com/horner/artipod-sync/issues/1)); git remains for in-pod text repos

## 0. How to work this plan (read me first)

This file is the single source of truth for progress. You (the implementer) keep it current: check boxes, fill worklogs, flip the tracker. If the plan and reality disagree, **fix the plan in the same PR as the code** — never silently diverge.

Read order: §1 (goal) and §6 (decisions already made) first; skim §2–§3 for the why/what; then work §4 phase by phase. Re-read the §3 subsection relevant to your current phase before starting it.

**Initial scope: Phases 0–6.6.** Phase 7 (live streams) is designed but out of scope until 0–6.6 ship — do not start it without re-planning. The target-state system is documented in `docs/` + `README.md` (status-bannered ✅/🔮); when implementation diverges from a doc, fix the doc in the same PR.

### Setup

- Sibling checkouts expected next to this repo: `../artipod-sync` (you will edit it in Phases 2–7), `../just-bash`, `../ozwell-artipod`, `../ui` (read-only references — **never edit `../just-bash`**, it is upstream).
- Node 20 LTS baseline (`engines` requires ≥20 since Phase 1 — ZenFS needs the stable `globalThis.crypto`, absent on EOL Node 18). Docker running locally from Phase 3 on. npm publish access to the `artipod` org is needed only at first publish (ask first).
- Baseline before touching anything: `npm ci && npm test` here **and** in `../artipod-sync` — record both results in the Phase 0 worklog.

### Working rules

1. **Order**: phases strictly 0 → 7; within a phase, top to bottom. Do not start phase N+1 until the phase-N gate commit is merged (or the owner explicitly approves overlap).
2. **Branches**: one branch per phase, named as in the tracker. PRs target `mieweb/artipod` `main` (+ a consuming PR in `horner/artipod-sync` where the phase says so).
3. **Commits**: small conventional commits (`feat(sandbox): …`, `test(oci): …`, `docs(plan): …`); roughly one per checked box. Checking a box happens **in the same commit** as the code that earns it.
4. **Phase gate (required)**: when every box including *Done when* is checked — worklog updated, tracker row flipped — finish with a commit `docs(plan): phase N gate`. At minimum, this commit exists at every phase transition.
5. **Verification**: never check a *Done when* box without running its check; paste the command + one-line result into the worklog.
6. **Deviations**: small (file name, signature tweak) → edit the plan item + worklog note. Architectural (would change §3 or §6) → stop and get owner sign-off first.
7. **Blocked?** After a genuine attempt, write the blocker into the worklog and raise it. Don't thrash silently.

### Ask-first list (owner sign-off required)

- npm publishes — owner runs them (or grants access): placeholder `@artipod/core@0.0.1` immediately (decided), first real `0.1.0` at the Phase 0 gate. Also owner-only: configuring npmjs **trusted publishing** for `@artipod/core` — the existing `.github/workflows/publish.yml` is set up for `@mieweb/artipod` and will fail on the renamed package until that's done.
- Anything touching the deployed artipod-sync service (`deploy/artipod-sync.service`, prod env, default registry allowlists).
- Deleting the re-export shims from artipod-sync (scheduled one release after Phase 2).

### Phase tracker (keep current)

| Phase | Branch | Status | PR |
|---|---|---|---|
| 0 — repo prep | `phase-0-esm-vitest` | done (owner npm actions pending) | [#33](https://github.com/mieweb/artipod/pull/33), [#34](https://github.com/mieweb/artipod/pull/34) |
| 1 — fs injection | `phase-1-podfs-injection` | done | [#35](https://github.com/mieweb/artipod/pull/35) |
| 2 — import sandbox/agent/proc | `phase-2-import-sandbox` | not started | |
| 3 — manifest + realizers | `phase-3-manifest-realizers` | not started | |
| 4 — OCI store | `phase-4-oci-store` | not started | |
| 5 — snapshots + commit | `phase-5-snapshots` | not started | |
| 6 — sync + manager | `phase-6-sync-manager` | not started | |
| 6.5 — encryption & authority | `phase-6.5-authority` | not started | |
| 6.6 — lazy hydration + site cache | `phase-6.6-hydration` | not started | |
| 7 — live streams | `phase-7-live-streams` | stretch — out of initial scope | |

### Reference map

| You need | Where |
|---|---|
| just-bash `IFileSystem` contract + the contract test to mirror | `../just-bash/packages/just-bash/src/fs/interface.ts`, `interface.contract.test.ts` |
| just-bash custom-command API (buffered ctx — why Phase 7 streams are host-side) | `../just-bash/packages/just-bash/src/custom-commands.ts` |
| Sandbox/adapter/commands to move in Phase 2 | `../artipod-sync/lib/sandbox/` (+ its `*.test.ts`) |
| Agent loop, clients, ONNX worker to move in Phase 2 | `../artipod-sync/lib/agent/` |
| `/proc` provider framework to move in Phase 2 | `../artipod-sync/lib/proc/` + its `README.md` |
| Session/proxy patterns to mine for `/manager` in Phase 6 | `../artipod-sync/lib/server/` |
| Components to thin into `/host` shells in Phase 2 | `../artipod-sync/components/Terminal.tsx`, `Editor.tsx`, `FileTree.tsx` |
| VS Code-schema tools + prompts (already in this repo) | `src/tools/`, `src/prompts/` |
| Docker hardening that must not regress | `src/containerUtils.ts`, `src/containerRuntime.ts` (podman detection), `container/` |
| OCI design source of truth (Phases 4–6) | [horner/artipod-sync#1](https://github.com/horner/artipod-sync/issues/1) |
| Encryption, keyring, leases, offline grants, delegation (normative) | `docs/encryption.md` |
| Agent confinement, sudo, approvals, admin policy (normative) | `docs/security-model.md` |
| Runtime/isolate/console target-state docs | `docs/browser.md`, `docs/linux.md`, `docs/bash-isolate.md`, `docs/console.md` |
| Verified just-bash session facts, security notes, upstream-PR candidates | `../artipod-sync/just-bash-plan.md` §5, §8, §10 |

## 1. Goal

`artipod/` (published as **`@artipod/core`** from the new `artipod` npm org; GitHub home stays `mieweb/artipod`) becomes the canonical **artipod layer**: a virtual-filesystem-centric pod abstraction with exactly three consumer surfaces:

1. **AI reasoning** — context building (`buildPrompt`), VS Code-compatible tools, prompts, agent loop, all operating on the pod's virtual fs.
2. **OCI revision control** — pod contents are OCI image/volume layers + a writable upper; snapshots, checkout, diff, commit per issue #1.
3. **Browser ↔ server synchronization** — commit/push/pull of OCI layers through pluggable transports; the same layer code runs in both runtimes.

`artipod-sync` stays a Next.js **app** (terminal, editor, tree, agent panel, storage UI, server routes) consuming `@artipod/core`. `ui/` becomes the second consumer (Phase 6 of just-bash-plan).

## 2. Where the two repos stand today (difference review)

| Concern | `artipod/` (`@mieweb/artipod`, branch `feature/vscode-tool-compatibility`) | `artipod-sync/` (horner, main) | Convergence direction |
|---|---|---|---|
| FS substrate | Direct `node:fs.promises` inside `ArtiMount` | ZenFS (IndexedDB / OPFS / memory) + `ZenFsAdapter` → just-bash `IFileSystem` | Inject a node-shaped promises fs into `ArtiMount`; ZenFS provides it in browser/server-virtual, `node:fs/promises` on real disk |
| Mount model | `ArtiMount(name, rootPath)`; `ArtiPod` = `Map<string, ArtiMount>` | Single ZenFS `/` mount (+ `/proc`, `/sessions/<id>` server-side) | Declarative **pod manifest** (mount table) realized per runtime; mount paths are app/harness-chosen (Decision #3) — docker's `/context/<name>` survives as that realizer's default template |
| Execution | Docker via dockerode (seccomp, CapDrop ALL, ReadonlyRootfs, tmpfs, limits) | just-bash sandbox (`lib/sandbox/`), execution limits, browser + Node | Two execution backends of one pod: `just-bash` (everywhere), `docker` (Node + real dirs). Later: container2wasm via 9P (issue #1) |
| AI tools | VS Code-schema tools: `read_file` (V1/V2), `create_file`, `list_dir`, `create_directory`, `replace_string_in_file`, `multi_replace_string_in_file`, `apply_patch`; `ToolRegistry`; OpenAI defs | `bash`, `read_file`, `write_file`, `list_files`; OpenAI **and** MCP serializers; 16 KiB truncation | artipod's schemas win (VS Code-trained models); add `bash` tool; adopt dual serializers + truncation from sync |
| Prompts / context | `buildPrompt()` XML context; `AGENT_INSTRUCTIONS`, `TOOL_USE_INSTRUCTIONS`, … | Ad-hoc system prompt in AgentPanel | artipod prompts + `buildPrompt` are the AI-reasoning surface for both |
| Agent loop | None (templates only) | `ToolCallingLoop`, `OzwellClient`, local ONNX (`lib/agent/local/`, WebGPU worker) | Move loop + clients into the artipod layer |
| Revision control | None | git (isomorphic-git): clone→push incl. PAT auth | git stays as an **in-pod** tool for repos; **pod-level** revision control = OCI snapshots (issue #1) |
| Sync | None | `components/wtf.md` sketch: client/server pod sync via git remote | OCI transports: direct registry, self-hosted proxy, OCI layout import; layers pushed/pulled, not files |
| Host-state introspection | None | `/proc` provider framework (`lib/proc/`), `lsmod`/`modprobe` | Move under the artipod layer (pod introspection for humans *and* models) |
| Server surface | `examples/web-demo` (Express + SQLite demo) | `/api/exec` (session sandboxes, hardened limits), `/api/git` CORS proxy | Routes stay app-level in artipod-sync; logic (`lib/server/`) moves or stays thin |
| Tests | Jest + ts-jest | Vitest (contract tests for adapter, sandbox, git, proc, agent, server) | **Vitest** for the merged package (ESM + browser parity) |
| Packaging | Single CJS-ish package → `dist/` | Next app, `@/lib` path alias | `@artipod/core` with **ESM subpath exports**; node-only code isolated (`/docker`) |
| Repo/org | `mieweb/artipod` | `horner/artipod-sync` | Code moves via PRs into `mieweb/artipod` |

### Known collisions to resolve deliberately

1. **`read_file` schema collision** — artipod's VS Code shape (`filePath`+`startLine/endLine` or `offset/limit`) vs sync's minimal shape. Keep artipod's; delete sync's on migration (its `bash`/truncation behavior is the part worth keeping).
2. **`ToolRegistry` is single-mount** — constructed with one `ArtiMount`; sync tools are sandbox-cwd-relative. Needed: pod-level registry resolving paths against each mount's declared root — no fixed prefix scheme (Decision #3).
3. **Result envelopes differ** — artipod returns structured `ToolResult` objects; sync tools return LLM-ready strings. Keep structured results as the source of truth + serializers (OpenAI string / MCP content) on top.
4. **Docker cannot bind virtual mounts** — a browser pod's IndexedDB-backed fs can't bind-mount into a container. That's not a bug: it's use case 3 (sync to server first, then execute with the docker backend). Document as an explicit constraint of the docker realizer.
5. **jest → vitest** and **CJS → ESM**: `examples/web-demo` consumes the package via `file:`; it retires to `attic/` in Phase 0. `examples/mcp-server` (added upstream, also `file:../..`) is already `"type": "module"` so the ESM flip helps it — but rebuild it to confirm; `examples/basic` imports `../../src` via ts-node and needs a tsx-era equivalent.
6. **Version pinning** — `artipod-sync` uses `@zenfs/core ^2.3.11`, `@zenfs/dom ^1.0.0`, `just-bash ^3.2.0`. ZenFS backend API (needed for `OciLayerFS`/`OciViewFS`) is version-sensitive: pin exact versions in `@artipod/core` peerDeps before Phase 4.

### 2026-08-30 addendum — upstream moved before Phase 0 started

The table above describes the repos as of the plan's writing (artipod branch `feature/vscode-tool-compatibility`). Before Phase 0 began, `mieweb/artipod` `main` absorbed that branch (PR #8, **rebased** — same messages, new SHAs; remote branch deleted) plus ~40 more commits, releasing **v0.3.1**. New on main and not reflected above:

- **Podman support** (`src/containerRuntime.ts`): automatic docker/podman detection (`detectRuntime`; machine/rootful/rootless modes).
- **Read-only mounts**: `new ArtiMount(name, root, readonly)` → bind-mounted `:ro`.
- **Main mount (breaking ctor change)**: `ArtiPod` now takes an options object; `useMainMount` defaults true and auto-creates a writable `main` mount under `workspaceDir`; `initialize()` is part of the lifecycle.
- **`run_in_terminal` tool** added to the VS Code-schema tool set (`src/tools/podTools.ts`, `PodToolRegistry`).
- **`examples/basic` + `examples/mcp-server`** (Hono-less MCP stdio server on `@modelcontextprotocol/sdk`, `file:../..` dep, already ESM).
- **CI exists**: `.github/workflows/nodejs.yml` (lint/build/jest/coverage on Node 18+20, docker tests included) and `publish.yml` (npm trusted publishing for `@mieweb/artipod` on release).
- Baseline moved: **161** jest tests (was 116).

Nothing upstream contradicts the convergence direction — podman/ro-mounts/main-mount slot into the docker realizer + manifest work (Phase 3), `run_in_terminal` joins the tool surface Phase 1 rationalizes. Phase 0 items below were adjusted in place; the plan/docs landed via `docs/layer-plan-landing` instead of the original merge step.

## 3. Target architecture

```mermaid
graph TB
    subgraph Manifest["Pod manifest (declarative)"]
        MAN["root image? + mounts[]<br/>{name, path, source, mode: ro|cow|rw}"]
    end

    subgraph Realizers
        RZ[realizeZenFs — browser + Node]
        RD[realizeDocker — Node, real dirs]
    end

    subgraph ZenGraph["ZenFS graph (per pod)"]
        OCI[".artipod/oci blob store<br/>(manifests, layers by digest)"]
        LFS[OciLayerFS — one layer, ro]
        VIEW[OciViewFS — ordered layers,<br/>whiteouts, opaque dirs]
        COW[ZenFS CopyOnWrite upper<br/>(the writable workspace)]
        IDB[(IndexedDB / OPFS / memory / disk)]
    end

    subgraph Layer["artipod layer (@artipod/core)"]
        CORE[core: ArtiPod, ArtiMount(fs-injected)]
        TOOLS[tools: VS Code-schema + bash<br/>OpenAI + MCP serializers]
        PROMPTS[prompts + buildPrompt]
        SBX[sandbox: just-bash + ZenFsAdapter<br/>+ git/edit/storage/module cmds]
        AGENT[agent: ToolCallingLoop,<br/>Ozwell + local ONNX clients]
        PROC[proc: /proc providers]
        OCIM[oci: store, snapshots,<br/>commit, transports]
        DOCKER[docker: containerUtils<br/>(node-only entry)]
    end

    subgraph Consumers
        SYNCAPP[artipod-sync (Next app):<br/>Terminal, Editor, Tree, AgentPanel,<br/>/api/exec, /api/git, /api/oci]
        UI[ui/src/components/AI]
        DEMO[examples/web-demo]
    end

    MAN --> RZ --> COW
    MAN --> RD
    VIEW --> COW
    LFS --> VIEW
    OCI --> LFS
    COW --> IDB
    CORE --> MAN
    SBX --> COW
    TOOLS --> CORE
    AGENT --> TOOLS
    OCIM --> OCI
    SYNCAPP --> Layer
    UI --> Layer
    DEMO --> Layer
```

Design rules carried over (unchanged):

- **One store, coherent views** — shell, git, tools, editor, tree all see the same ZenFS graph.
- **`lib/sandbox`-style framework-freedom** — nothing in the layer imports React/Next/`window` at module top level.
- **git is a trusted host command**, outside just-bash's network firewall; PATs never live in the sandbox fs.
- **Container hardening posture** (seccomp, CapDrop, ReadonlyRootfs) is unchanged for the docker backend.

### Package layout (subpath exports, ESM)

```
@artipod/core            core: ArtiPod, ArtiMount, manifest types, pod events (isomorphic)
@artipod/core/tools      tool registry, VS Code-schema tools, bash tool, serializers
@artipod/core/prompts    templates + buildPrompt helpers
@artipod/core/sandbox    just-bash sandbox, ZenFsAdapter, custom commands, storage backends
@artipod/core/agent      loop, clients (ozwell, local ONNX), tool bindings
@artipod/core/proc       /proc provider framework
@artipod/core/host       headless UI controllers: TerminalSession, FileBuffer, TreeSource
@artipod/core/console    Ctrl+~ drop-in overlay console (docs/console.md)
@artipod/core/manager    PodStore + pod/session hosting + keyring/leases/policy (Phases 6–6.5)
@artipod/core/oci        blob store, layer index, OciLayerFS, OciViewFS, snapshots, transports
@artipod/core/docker     containerUtils (node-only; never imported by browser entries)
```

Single package with subpaths (like `@mieweb/ui/kerebron`) rather than a monorepo — fewer moving parts, one version, and the browser/node split is handled by export conditions. Scope: the `artipod` npm org (created 2026-08-30); `@artipod/core` mirrors the `@zenfs/core` convention, and issue #1's satellites (`@artipod/oci-9p`, `@artipod/container2wasm`) become sibling packages when they materialize. Revisit the single-package call only if `oci` grows a wasm dependency.

### Browser UI surfaces — headless core, thin shells

The terminal window, editor, and file navigation do **not** move into the package as React components. The package ships framework-free controllers (`/host`); apps keep thin `'use client'` shells. Today all three artipod-sync components embed reusable logic in React and wire coherence by hand (FileTree's manual Refresh button, Editor blind to shell-made changes, Terminal's `registerWriter` hand-off for agent echo) — that logic is what gets extracted.

**The unifier: pod events (core).** `pod.events` emits `exec:start` / `exec:end` (rides the existing `createSandbox` `beforeExec`/`afterExec` hooks, same slot `/proc` uses), `fs:changed` (from tool writes, `FileBuffer.save`, git ops; plus a coarse invalidate after every `exec:end`, since bash can touch anything), `edit:request` (generalizes the current `onEdit` callback), `agent:tool-call` (replaces `registerWriter`), and later `snapshot:*` / `sync:*`. Do **not** rely on ZenFS `fs.watch` — command-boundary invalidation is the contract.

| Surface | Headless in `/host` | Stays in the app (artipod-sync now, `ui` bindings in Phase 2's Storybook proof) |
|---|---|---|
| Terminal | `TerminalSession`: line discipline (buffer, history ↔ `BASH_HISTORY`, common-prefix tab completion via `sandbox.complete()`, Ctrl+C abort, prompt from cwd, `\n`→`\r\n` normalization). I/O contract: `handleData(data)` in, `write(text)` out — anything xterm-shaped satisfies it; tests use a fake | xterm instantiation, addons (fit, web-links), theme, banner, the `<div ref>` |
| Editor | `FileBuffer`: `open(pod, path)` → content, `save()`, `isDirty`, external-change detection (subscribe `fs:changed` for own path → reload-if-clean / warn-if-dirty), language-from-extension helper. Editor-agnostic: Monaco here, kerebron RichEditor or CodeMirror in `ui` | Monaco (`@monaco-editor/react`), save/close chrome, dirty dot, error banner |
| File nav | `TreeSource(pod)`: `getItem(path)` / `getChildren(path)` + `onDidChange` invalidation from `fs:changed` — structurally matches react-complex-tree's `TreeDataProvider` (incl. its change-listener slot) without importing its types. Roots come from the pod manifest (each mount's declared `path`), not a hardcoded `/repo` | react-complex-tree environment, styling, selection → `edit:request` |

App-level concerns that stay out of the package entirely: Next SSR guards (`dynamic(…, { ssr: false })` for xterm/Monaco — `/host` itself must stay import-safe in Node for tests), URL deep-linking (e.g. `?file=/context/src/x.ts` — pod-relative paths make links shareable across browser/server pods), tab layout, and the multi-tab read-only mode (UI must respect `isPrimaryTab` from storage init; controllers should accept a `readOnly` flag so Editor/Tree disable mutations in secondary tabs).

### Security & authority model (normative detail in docs/)

Four rules, specified fully in [docs/encryption.md](docs/encryption.md) and [docs/security-model.md](docs/security-model.md):

1. **Ciphertext at rest, keys on lease.** Layers *and* the writable upper are chunked-AEAD encrypted; usable KEKs live only in a memory keyring under a TTL lease (`/proc/keys` shows expiries). Lock = key evaporates; login restores. Offline = signed device-wrapped grants (e.g. 24 h) with ceremony-gated unlock.
2. **Authority is a certificate chain.** Home base can delegate scoped, offline-verifiable authority to site/ship/station managers (lease issuance, grant validation, policy enforcement) — this is what makes the rig/interplanetary/relay profiles work; relays can stay blind (ciphertext only, digests verify end-to-end).
3. **The agent is confined to its pod; `sudo` is the only escape.** Privileged verbs raise `approval:request`; a human must approve; the human's approval only counts if signed admin policy grants them the approver role; banned classes fail EPERM without prompting; approvals mint scoped TTL capabilities; everything audited into pod provenance. For agents this boundary is *real* (they act only through the tool layer); for humans it is ceremony + cryptography — never claim more.
4. **Encryption is per-pod opt-in from Phase 4, default off until 6.5** — core phases never block on crypto.

## 4. Phases

Each phase = one reviewable PR series into `mieweb/artipod` (+ a consuming PR in `horner/artipod-sync` where noted). Phases run strictly in order and each ends with the gate commit from §0. Every phase has a **Done when** checklist (run the check, then tick) and a **Worklog** (append dated notes: decisions, deviations, gotchas, verification output).

### Phase 0 — Decisions + repo prep

> **Branch** `phase-0-esm-vitest` · **Status** _not started_

- [x] **Decided — do first:** ~~PR + merge `feature/vscode-tool-compatibility` → `main`~~ Overtaken by events: upstream already merged it (PR #8, rebased) and `main` moved to v0.3.1 — see §2 addendum. Replacement action done instead: cherry-picked the two plan/docs commits onto `docs/layer-plan-landing` (README conflict resolved per Decision #11 — target-state README kept, v0.3.1 README archived as `attic/v0.3-node.README.md`, quick-start updated to the options-object API) → PR → `main`. `phase-0-esm-vitest` branches from that updated `main`.
- [x] Ratify decisions: repo home = `mieweb/artipod`, npm name = **`@artipod/core`** (org created 2026-08-30); ESM + subpath exports; vitest replaces jest; exact-pin `just-bash` (3.2.0), `@zenfs/core` (2.4.4), `@zenfs/dom` (1.2.5) as peer deps matching artipod-sync's lockfile — added as **optional** peerDependencies (deviation: optional until `/sandbox` code actually consumes them in Phase 2, so plain node consumers aren't forced to install ZenFS).
- [x] Add the missing `LICENSE` file (MIT, matching package.json), fill `author` (Medical Informatics Engineering, LLC); also added `repository`/`homepage`/`bugs` fields — npm provenance via the existing trusted-publishing workflow requires the repository match.
- [ ] Owner publishes the `@artipod/core@0.0.1` placeholder to reserve the name (ask-first — flagged to owner; trusted-publishing config for the new name is also owner-side).
- [x] Convert `artipod/` build to **pure ESM** with `exports` map (no dual CJS build); migrate jest specs to vitest (mechanical: `jest.fn` → `vi.fn`) — in practice zero `jest.*` calls existed; the whole migration was import extensions + config.
- [x] Retire `examples/web-demo` to `attic/` — superseded by the Phase 6 north-star demo (browser demo pod → clone → push/pull to server → snapshot/compact). `examples/basic` + `examples/mcp-server` stay but must survive the ESM flip (mcp-server: rebuild against the ESM package; basic: ts-node → tsx or node --import).
- [x] CI: convert `.github/workflows/nodejs.yml` from jest to vitest (keep lint/build/coverage lanes) — conversion is transitive: the workflow invokes `npm test`/`npm run test:coverage`, whose scripts now run vitest; workflow file unchanged. `publish.yml` left pointed at the renamed package; do **not** cut a release until the owner configures trusted publishing for `@artipod/core` (ask-first). Add a browser-ish lane later (Phase 2) via vitest + happy-dom or Playwright.

**Done when:**

- [x] `npm test` green under vitest/ESM (same suites that passed under jest — no skipped tests without a worklog note) — verified: 5 files / **161 tests** passed, 0 skipped (same count as jest baseline)
- [x] Built output is ESM with an `exports` map; importing the built package from a scratch `node` ESM script works — verified: `/tmp/artipod-esm-smoke` installs the package and imports `@artipod/core` + `/tools` + `/prompts` subpaths
- [x] `examples/web-demo` moved to `attic/`; README points at the Phase 6 north-star demo — verified: `examples/README.md` web-demo section now points at `attic/web-demo` + the plan's Phase 6 demo
- [x] CI runs vitest on push — verified: PR #34 checks green on Node 18.x + 20.x (≈2m40s each; nodejs.yml unchanged — its `npm test`/`npm run test:coverage` steps now invoke vitest)

**Worklog:**

- 2026-08-30 — handoff baseline (§0 setup, recorded pre-work): artipod `npm test` → Jest, 5 suites / 116 tests green (incl. Docker container tests, Docker running); artipod-sync `npm test` → Vitest, 10 files / 101 tests green.
- 2026-08-30 — pre-phase reconciliation: found upstream had merged `feature/vscode-tool-compatibility` (PR #8, rebased SHAs) and advanced `main` to v0.3.1 (§2 addendum: podman, ro-mounts, main-mount breaking ctor, `run_in_terminal`, examples/basic+mcp-server, CI+publish workflows). Cherry-picked 7c75e8e + 6353955 onto `docs/layer-plan-landing`; only conflict was README.md, resolved per Decision #11 (target-state kept; v0.3.1 README → `attic/v0.3-node.README.md`; quick-start rewritten for the options-object ctor + podman mention).
- 2026-08-30 — re-baseline on reconciled branch (= main v0.3.1 + docs): `npm ci && npm test` → jest 5 suites / **161 tests** green, 38.9s (Docker 29.4.0 up; node v22.18.0 / npm 10.9.3; engines ≥18 satisfied).
- 2026-08-30 — ESM conversion: `type: module`, tsconfig → `module/moduleResolution NodeNext`, `target ES2022`, `types [node, vitest/globals]`; 55 relative imports given `.js` extensions (54 from the grep sweep + one type-only `import('./artimount')` in types.ts that TS2835 caught); directory imports `./tools`/`./prompts` → explicit `/index.js`. Zero CJS-isms existed in src (no `__dirname`/`require`).
- 2026-08-30 — package identity: `@artipod/core@0.1.0`, exports map (`.`, `./tools`, `./prompts`, `./package.json`), `repository`/`homepage`/`bugs` added (trusted-publishing provenance needs the repository match), author = Medical Informatics Engineering, LLC, LICENSE (MIT) added. Peers exact-pinned from artipod-sync lockfile: just-bash 3.2.0 / @zenfs/core 2.4.4 / @zenfs/dom 1.2.5, marked optional (see item note).
- 2026-08-30 — vitest migration: jest.config.js deleted; vitest.config.ts with `globals: true`, node env, v8 coverage (text/lcov/html → `coverage/`). Specs used zero `jest.*` APIs; per-test `120000` timeout third-args carry over 1:1 (vitest hookTimeout default 10s ≥ jest's 5s). Verification: `npm run lint` clean, `npm run build` clean, `npm test` → **161/161** in 36.2s, `npm run test:coverage` → lcov.info 38 KB written.
- 2026-08-30 — examples: `examples/web-demo` → `attic/web-demo` (`.gitignore` gained attic equivalents of the examples ignores); `examples/mcp-server` reinstalled + rebuilt against the ESM package, `import('artipod')` resolves; `example:basic` script switched ts-node → tsx (runs the full demo incl. a container start — note: first `npx tsx` run prompts interactively to install tsx). CI workflow untouched by design: script names are stable, so nodejs.yml now runs vitest transitively; publish.yml untouched — owner must configure npmjs trusted publishing for `@artipod/core` before any release.
- 2026-08-30 — phase 0 gate (PR #34, CI green both Node lanes). Deviation, rule 6: gate taken with one box open — the owner-side `@artipod/core@0.0.1` placeholder publish (+ trusted-publishing config). It is an npm-side action that doesn't gate Phase 1 code; flagged to owner in the PR body and directly.

### Phase 1 — Make the core isomorphic (fs injection)

> **Branch** `phase-1-podfs-injection` · **Status** _not started_

The one structural refactor everything else depends on. `ArtiMount` already uses only the `fs.promises` shape — ZenFS exposes exactly that.

- [x] Define `PodFs` = minimal node-shaped promises interface (readFile, writeFile, mkdir, readdir(+withFileTypes), stat, rm, rename) in core (`src/podfs.ts`; lstat deferred until something needs symlink awareness).
- [x] `ArtiMount` takes `fs: PodFs` (4th constructor param; `nodePodFs()` default keeps existing callers working — deviation: the default lives in artimount.ts via static import rather than a separate node entry; the browser/node export-condition split arrives with Phase 2/3). Bonus: boundary-exact traversal guard (`/a` no longer admits `/aX`), `write()` widened to `Uint8Array`, docker code isolated under `src/docker/` with a `./docker` subpath export.
- [x] Pod-level `ToolRegistry`: `PodToolRegistry` now accepts a declarative `mountTable` (`{path, mount}[]`, absolute app-chosen paths, longest-prefix resolution, virtual directory listings above mount points, apply_patch header rewriting confined to a single mount) — core enforces no prefix scheme (Decision #3); `MountToolRegistry` stays as the single-mount sugar.
- [x] Add `bash` tool (schema + truncation semantics ported from `artipod-sync/lib/agent/tools.ts`) — execution delegated to an injected `BashExecutor` (`containerBashExecutor(pod)` default until the Phase 2 sandbox lands).
- [x] Port the OpenAI + MCP dual serializers onto artipod's `ToolDefinition`s (`toOpenAiTools` / `toMcpTools`).
- [x] Contract test: the full tools suite runs twice — over `node:fs/promises` (tempdir) and over ZenFS `InMemory` — same assertions (`src/__tests__/contract.spec.ts`, `describe.each` over the two providers).

**Done when:**

- [x] One shared contract suite for tools + `buildPrompt` runs twice — over `node:fs/promises` (tempdir) and over ZenFS `InMemory` — with identical assertions, green — verified: vitest 197/197, contract suite runs `describe.each` over both providers
- [x] `buildPrompt` output byte-identical across both fs implementations (fixture snapshot) — verified: `toBe` across providers + snapshot written to `__snapshots__/contract.spec.ts.snap`
- [x] `grep -rn "node:fs\|from 'fs'" src/` shows **import** hits only in `src/docker/`, the `nodePodFs` adapter, and the docker-backend spec (`containerExecution.spec.ts`, which exercises chmod-dependent container behavior); remaining textual hits are doc comments — wording amended per rule 6
- [x] `bash` tool schema + 16 KiB truncation behavior covered by ported tests — verified: truncation head/tail/marker tests + JSON content body + schema shape in contract.spec.ts

**Worklog:**

- 2026-08-30 — implemented in one PR (#35): podfs.ts + nodePodFs.ts; ArtiMount/ArtiPod fs injection (auto main mount inherits pod fs); containerUtils/containerRuntime → src/docker/ (+ `./docker` export); PodToolRegistry mountTable (longest-prefix resolver, virtual dirs above mounts, cross-mount multi_replace per-owning-mount, apply_patch single-mount header rewrite); bash tool + BashExecutor (container default); serializers; contract suite (node tempdir × ZenFS InMemory) + buildPrompt snapshot. @zenfs/core 2.4.4 devDep (peer already pinned in Phase 0).
- 2026-08-30 — security fix en route: ArtiMount traversal guard was prefix-sloppy (`resolved.startsWith(rootPath)` admits `/rootX`); now boundary-exact with a pinned contract test on both backends.
- 2026-08-30 — tools.spec updated: PodToolRegistry now always carries `bash` alongside `run_in_terminal` (2 tools); zero other spec changes beyond import extensions/adapters.
- 2026-08-30 — verification: `tsc --noEmit` clean; lint clean; vitest **197/197** (was 161 — +36 contract/truncation/serializer/resolver tests); build clean.
- 2026-08-30 — post-merge CI fix (`fix/node-20-baseline`, PR #36): PR #35's CI failed only on the **Node 18** lane — `@zenfs/core` polyfills read `globalThis.crypto.randomUUID` at import, which EOL Node 18 lacks; Node 20's tests passed (its job died on fail-fast cancellation of the coverage step). Matrix now 20.x + 22.x, `engines` ≥20. Process note: PR #35 was merged while checks were red because a `| tail` pipe swallowed the checks-watch exit code — don't pipe `gh pr checks --watch`; merge gates on its raw exit from now on.

### Phase 2 — Move sandbox, agent, proc into `@artipod/core` (executes just-bash-plan Phase 6)

> **Branch** `phase-2-import-sandbox` · **Status** _not started_ · includes a consuming PR in `horner/artipod-sync`

- [ ] Move `artipod-sync/lib/sandbox/` → `@artipod/core/sandbox` (incl. `zenfs-adapter`, `git-command`, `edit-command`, `notes/storage/module` commands, `storage.ts`, `table.ts`) with their vitest suites.
- [ ] Move `artipod-sync/lib/agent/` → `@artipod/core/agent` (loop, ozwell client, `local/` ONNX worker stack). Replace its `read_file`/`write_file`/`list_files` with bindings to `/tools` (schema collision #1 resolved here). Keep `bash` + truncation. Tests must satisfy Decision #8: scripted fakes only — no live model calls, no model downloads, no default AI endpoint shipped (audit the `local/` suite's mocks on the way in).
- [ ] Move `artipod-sync/lib/proc/` → `@artipod/core/proc`.
- [ ] Add `pod.events` (core) + extract `/host` controllers (`TerminalSession`, `FileBuffer`, `TreeSource`) from the logic currently embedded in `Terminal.tsx` / `Editor.tsx` / `FileTree.tsx`; rewire those components as thin shells. Acceptance detail: tree auto-refreshes after every command, editor detects external changes to its open file, agent tool-call echo arrives via `agent:tool-call` (no `registerWriter`).
- [ ] artipod-sync consumes via workspace/path dep; `lib/sandbox` etc. become re-export shims for one release, then delete. `lib/server/`, routes, components stay in the app.
- [ ] Wire `createSandbox` into the pod: `pod.createSandbox()` mounts the realized fs and registers the pod's custom commands.
- [ ] **Agent confinement stub (default-deny)**: tools/bash confined to the pod; `sudo` is recognized but returns EPERM with "approval flow lands in Phase 6.5" — pinned by tests (docs/security-model.md is normative).
- [ ] `/console` module: `installConsole({ pod, hotkey })` — builtin zero-dep renderer, `` Ctrl+` ``/`Ctrl+~` hotkey, SSR-safe no-op, honors `isPrimaryTab`; consumes only `/host` controllers + `pod.events` (docs/console.md).
- [ ] `ui/` proof: Storybook story where AIChat drives the sandbox via MCPToolCall rendering (the original Phase 6 acceptance).

**Done when:**

- [ ] All moved vitest suites green in this repo (sandbox, agent, proc — same counts as they had in artipod-sync)
- [ ] artipod-sync behavior unchanged: clone → pipeline commands → edit → commit → reload persists (Playwright e2e if present, else the manual script — record which in the worklog)
- [ ] Duplicated tool code deleted from artipod-sync; only re-export shims remain (their deletion is on the ask-first list)
- [ ] Event wiring proven in the app: tree auto-refreshes after every command, editor detects external changes to its open file, agent echo arrives via `agent:tool-call`
- [ ] `ui/` Storybook story runs (AIChat driving the sandbox, MCPToolCall rendering)

**Worklog:**

- _(empty)_

### Phase 3 — Pod manifest + realizers

> **Branch** `phase-3-manifest-realizers` · **Status** _not started_

- [ ] Manifest type in core (aligned with issue #1's "Artipod mount declaration"):

```ts
interface PodManifest {
  root?: { image: string };                    // OCI ref (Phase 4 makes this real)
  mounts: Array<{
    name: string;                              // ArtiMount name
    path: string;                              // app/harness-chosen (Decision #3): /context/src, /patients/12345, …
    source:                                    // realizer-specific
      | { kind: 'hostDir'; dir: string }       // node/docker only
      | { kind: 'backend'; backend: 'indexeddb' | 'opfs' | 'memory' }
      | { kind: 'volume'; ref: string };       // OCI volume (Phase 4)
    mode: 'ro' | 'cow' | 'rw';
  }>;
}
```

- [ ] `realizeZenFs(manifest)` → ZenFS mount configuration (browser + Node); `realizeDocker(manifest)` → bind each `hostDir` mount at its manifest `path` (the historical fixed `/context/<name>` layout becomes just the default template our apps use); reject virtual sources with a clear error — collision #4.
- [ ] `buildPrompt`/tools/sandbox operate on the realized pod; `/proc/pod/manifest.json` provider exposes it to shell + model.
- [ ] artipod-sync boots from a manifest (its current single-`/` layout expressed as one `rw` mount) instead of bespoke init.

**Done when:**

- [ ] Contract test: the same manifest produces the same file view in a browser-style (ZenFS) sandbox and a Node sandbox
- [ ] Docker realizer runs a command against `hostDir` mounts with the existing hardening tests still green
- [ ] A manifest with a virtual source fails fast on the docker realizer with an actionable error (test)
- [ ] artipod-sync boots from a manifest (its current single-`/` layout expressed as one `rw` mount)

**Worklog:**

- _(empty)_

### Phase 4 — OCI store + layer filesystems (issue #1 steps 1–5)

> **Branch** `phase-4-oci-store` · **Status** _not started_

All inside `@artipod/core/oci`, implemented as ZenFS backends so every consumer (shell, tools, git, editor) sees them for free:

- [ ] Blob store under `/.artipod/oci/{blobs,indexes,refs,snapshots,upper}` — digest-addressed, originals immutable and verifiable.
- [ ] **Pod superblock** (cleartext, per store): opaque pod ID, cipher suite, key-envelope refs, timestamps — enumeration without keys (docs/encryption.md#at-rest-format).
- [ ] **Ciphertext blob format** (per-pod opt-in flag, default off until 6.5): chunked AES-256-GCM (~4 MiB, per-chunk nonce+tag, encrypted index), dual digests (plaintext diff ID + ciphertext address), decrypt-on-read chunk store *below* `OciLayerFS`; the CoW upper encrypts per generation under the same envelope.
- [ ] Tar indexer (`LayerEntry[]` per issue) + decompress-once policy (keep compressed original + uncompressed content-addressed twin). Browser gzip via `DecompressionStream` with `fflate` fallback — just-bash's gzip is Node-only, do not reuse.
- [ ] **Published layer indexes**: each layer's `LayerEntry[]` index ships as a small digest-addressed artifact beside the manifest (`application/vnd.artipod.layer.index.v1+json`), generated at commit/push — so the complete namespace is knowable with zero layer blobs (the Phase 6.6 hydration substrate). Foreign images without published indexes: a site cache or full pull generates them. `/api/oci` proxy passes `Range` through for byte-offset **resume** of interrupted blob downloads (blobs verify whole — no partial-verification machinery).
- [ ] `OciLayerFS` — read-only ZenFS backend over one indexed layer (`/mnt/oci/layers/<n>` inspection mounts).
- [ ] `OciViewFS` — single flattened read-only view over ordered layers with OCI whiteout semantics (`.wh.*`, `.wh..wh..opq`, `--through N`).
- [ ] `CopyOnWrite` upper on top of the view = the pod workspace (manifest `root.image` + `volume` sources become real).
- [ ] Transports behind one interface (`resolve`/`fetchBlob`): `DirectRegistryTransport`, `ArtipodRegistryProxyTransport` (new `/api/oci` route in artipod-sync; **allowlist injected at initialization, default empty = deny all**; the hosted demo config enables docker.io + ghcr.io + quay.io), `OciLayoutTransport` (import a local layout, incl. from a `hostDir` mount).
- [ ] Shell surface via `defineCommand('artipod', …)` in the sandbox: `image pull|ls|inspect|history|mount [--through N]`, `layer mount|inspect`.

**Done when (from the issue):**

- [ ] `artipod image pull docker.io/library/alpine:3.22` succeeds through the proxy in a browser
- [ ] Mount the view; `cat /etc/os-release` returns Alpine content
- [ ] `artipod image mount … --through 2` shows the truncated history view
- [ ] Digests verify on pull; a tampered blob is rejected (test)
- [ ] Blobs and refs survive a full page reload

**Worklog:**

- _(empty)_

### Phase 5 — Snapshots + commit = pod revision control (issue #1 steps 6–7)

> **Branch** `phase-5-snapshots` · **Status** _not started_

- [ ] Snapshot manifests (references, not copies): `{ image: { manifestDigest, layers, through }, upper: { generation, parent } }`.
- [ ] `artipod snapshot create|ls|checkout|mount|diff` — checkout creates a **new writable branch** (git-commit-like), never destroys later history.
- [ ] `artipod commit --tag` — freeze the upper into a tar+gzip diff layer, produce a new manifest (image or `application/vnd.artipod.volume.v1` artifact), store locally; `artipod gc` for unreachable blobs.
- [ ] `artipod compact` — squash a snapshot chain into a single diff layer (new manifest; superseded blobs become `gc`-able), so long agent sessions don't accumulate hundreds of layers.
- [ ] **AI-reasoning tie-in:** agent-loop hook (default **on**) snapshotting before each tool-executing turn → `artipod snapshot diff` shows exactly what the model changed; rewind = checkout. Cheap by construction — a snapshot is a manifest reference + upper generation mark, not a file copy. (VS Code chat checkpoints and Claude Code rewind approximate this with shadow copies of *tool-edited files only*; neither captures shell side effects — artipod's layered fs captures everything the turn did.) Opt-out flag + `compact`/`gc` bound storage for huge-churn jobs.

**Done when:**

- [ ] edit → `snapshot create` → keep editing → `checkout` the snapshot → both branches mountable simultaneously
- [ ] `snapshot diff` between the two branches lists exactly the expected paths
- [ ] Agent-turn auto-snapshots appear in `snapshot ls` (and the opt-out flag suppresses them)
- [ ] `compact` squashes a chain into one diff layer; `gc` reclaims the superseded blobs (byte counts verified)

**Worklog:**

- _(empty)_

### Phase 6 — Browser ↔ server synchronization

> **Branch** `phase-6-sync-manager` · **Status** _not started_ · includes a consuming PR in `horner/artipod-sync`

- [ ] `artipod clone|push|pull <ref>` — clone materializes a ref as a new local pod (browser or server); push/pull exchange volume/image manifests + missing blobs by digest through a transport (registry or `/api/oci` proxy). Digest-addressed blobs make resumable, dedup'd sync trivial (only missing digests move).
- [ ] `/manager` + `PodStore`: a **pod manager** is whatever hosts pods (the artipod-sync server, a future daemon, the browser tab itself). Each manager configures durability via the `PodStore` interface — shipped impls: ZenFS-on-disk, plain dir with OCI image layout, remote registry — and decides how/when it communicates changes. The hosted artipod-sync manager uses the **OCI image-layout directory** store first (Decision #6: inspectable with skopeo/crane, trivial to back up/import). The generic pod/session hosting from `lib/server/exec-sessions.ts` graduates here; HTTP wiring, auth, and rate-limit policy stay in the app.
- [ ] Sync semantics: anti-entropy exchange of digest-addressed blobs + refs. The blob set is add-only and content-addressed — a convergent replicated set — so managers can sync in any order/direction and converge (the "all artipods sync up" CRDT idea, applied at the distribution layer). Divergent writable uppers are **branches** resolved by explicit merge/checkout (no auto-merge in v1); live per-document co-editing CRDTs (Yjs, kerebron-style) are a complementary *in-file* mechanism, orthogonal to layer sync.
- [ ] Server pod: `/api/exec` sessions get manifest-driven pods (Phase 3) instead of a bare `/`; a synced ref materializes the same workspace server-side.
- [ ] Round-trip flow (replaces wtf.md's git-remote sketch as the *pod* sync mechanism): browser `commit` → `push` → server `pull` + heavy execution (docker backend, real tools) → server `commit` → browser `pull` → new layer appears as a snapshot branch. Append-only provenance for AI outputs, exactly as `plan-artipodSync.prompt.md` wanted — but with OCI instead of a bespoke CAS.
- [ ] Defer (explicitly out of scope for v1, tracked in issue #1 comments): eStargz lazy pull, chunked layers, 9P/container2wasm. (Encryption/envelopes moved into scope as Phase 6.5; `ArtipodPeerTransport` returns in Phase 7 as the P2P leg of live streams.)

**Done when — the north-star demo (the `examples/web-demo` replacement), each step scripted or recorded:**

- [ ] Browser creates a demo pod → edits offline → `artipod snapshot create`
- [ ] `artipod clone` into a second local pod
- [ ] Reconnect → `push`; server manager `pull`s and runs a containerized job (docker realizer) over the same content
- [ ] Server `commit`s a derived layer → browser `pull`s it and mounts it read-only next to the workspace
- [ ] `artipod compact` squashes the browser pod's history

**Worklog:**

- _(empty)_

### Phase 6.5 — Encryption & authority

> **Branch** `phase-6.5-authority` · **Status** _not started_ · normative specs: [docs/encryption.md](docs/encryption.md), [docs/security-model.md](docs/security-model.md)

- [ ] **Keyring** in `/manager`: unwrapped KEKs with expiries, memory-only non-extractable CryptoKeys; `/proc/keys` provider (names + expiries, never material).
- [ ] **Leases**: `artipod login` → server/authority unwraps KEKs + issues signed lease `{podIds, ttl}`; auto-lock on expiry + `visibilitychange`; `artipod lock [--all]`; post-lock reads fail `EACCES` with a login hint; `lock` vs `purge` policy modes.
- [ ] **Encryption flips on**: Phase 4's ciphertext format live end-to-end — encrypted pull/mount/edit/commit/push with plaintext existing only in memory.
- [ ] **Offline grants**: device keypair enrollment (non-extractable, persisted), signed grant `{pods, device, permissions, notBefore, expires, maximumSnapshot, allowExport}`, ceremony-gated unlock (passkey/PIN), monotonic clock high-water mark (refuse on rollback), CRL-on-sync revocation.
- [ ] **Delegation certs**: scoped sub-authority managers (lease issuance, grant validation, policy enforcement) verified by signature chain alone; blind-relay vs entitled-cache manager modes.
- [ ] **Priority + budgeted sync**: refs/manifests → small deltas → bulk blobs; bandwidth budget knob; resume from chunk offsets (constrained-link profiles).
- [ ] **sudo approval flow**: `approval:request` event with structured capability `{verb, target, mode, ttl, justification}`; signed admin policy (approver roles, capability classes, `defaults.approvable:false`); banned classes → instant EPERM, no prompt; approval mints a scoped TTL capability in the keyring; audit events appended to pod provenance. Replaces the Phase 2 EPERM stub.
- [ ] **Console integration**: lock screen + login in `/console`; `approval:request` prompts render there when the host app has no UI for them.

**Done when:**

- [ ] Lease expiry locks the pod → reads fail `EACCES` → `artipod login` restores — without data rewrite (test)
- [ ] Offline grant survives reload, unlocks only via ceremony, expires by grant time, refuses on clock rollback (tests)
- [ ] `sudo` on a policy-banned class returns EPERM with **no prompt**; a user without the approver role cannot approve; an approval mints a TTL capability visible in `/proc/keys` and expires (tests)
- [ ] Audit: every request/decision appended to pod provenance and survives push/pull (test)
- [ ] Blind relay round-trip: intermediate manager holds zero keys, end-to-end digests verify (test)
- [ ] Delegated manager issues a valid lease fully offline (signature-chain verification only) (test)

**Worklog:**

- _(empty)_

### Phase 6.6 — Lazy hydration & site cache

> **Branch** `phase-6.6-hydration` · **Status** _not started_ · driving use case: pull one pod per patient on today's schedule — visit notes eager, DICOM on demand, LAN cache making the browser fast

**The OCI layer is the unit of hydration.** A pulled pod materializes at `refs` (manifest only) · `index` (manifest + published layer indexes + eager layers — every file in a lazy layer is a **placeholder**: `ls`/`stat`/tree serve size/metadata from the index, content absent) · `full`. Opening a file hydrates its *winning layer* (OciViewFS resolution), whole blob, digest-verified — no seekable-tar/eStargz/SOCI machinery, ordinary OCI throughout (annotations + one small index artifact per layer). Issue #1's volume separation is the first lever: the patient-record volume (markdown/FHIR) is eager; the imaging volume is lazy.

- [ ] **Layer grouping at commit time** (where the intelligence lives): `artipod commit --layer-group 'dicom/**'` routes heavy paths into dedicated layers — ideally one study/dataset per layer so a click fetches a likely-needed-together unit; descriptor annotation `org.artipod.hydration: lazy|eager` (default by size threshold).
- [ ] **Pull-time policy** — which layers hydrate up front:

```ts
interface HydrationPolicy {
  default: 'eager' | 'lazy';       // falls back to annotation, then size threshold
  eager?: string[];                // globs — layers containing matching paths hydrate up front
  maxEagerLayerSize?: number;
}
```

- [ ] **Whole-layer fetch, cache-friendly**: hydration downloads the layer blob, verifies its digest, indexes it once, caches it (one OPFS file per blob — a natural fit). Interrupted downloads resume by byte offset (`Range`). If layer granularity later proves too coarse for some workload, seekable formats (eStargz/SOCI/artipod-chunked) slot in behind the same `LazyLayer` abstraction without changing the pod model.
- [ ] **Read semantics — no grep bombs** (unchanged property): fs reads of dehydrated content fail fast (`EREMOTE`-style) with an `artipod hydrate <path>` hint. Hydration is always an explicit act: UI click (hydrate-then-open), `artipod hydrate|dehydrate <glob>` (operates on the layers backing the glob), or the agent `prefetch` tool.
- [ ] **Three bandwidth lanes** at the manager (extends 6.5's budgeted sync): **interactive** (on-click hydration, reserved headroom) ≻ **prefetch** (rules + AI hints) ≻ **background** (push/pull); budgets configurable, prefetch yields to interactive.
- [ ] **AI prefetch**: `prefetch(paths|globs, priority)` becomes a pod-confined agent tool — paths resolve to their backing layers, which warm inside the prefetch budget ("orders mention chest CT → prefetch that study's layer"). No approval needed: in-pod, bandwidth-bounded, audit-visible.
- [ ] **Site cache manager (Linux)**: a delegated manager as LAN pull-through cache — digest-keyed, verify-on-receipt, **blind (ciphertext) for encrypted pods** so PHI never sits plaintext on the cache box; browser transports try site cache → WAN fallback; an overnight job pre-pulls the schedule's pods.
- [ ] Surface: hydration state in `/proc/hydration` + tree badges; `fetch:start|progress|done` on `pod.events`.

**Done when:**

- [ ] `index`-level pull transfers only manifests + index artifacts (byte counters); the full namespace lists/stats correctly at near-zero storage cost
- [ ] Opening a placeholder fetches exactly one layer blob (transfer counters), digest verifies, content opens; the same open while offline errors clearly with the hydrate hint
- [ ] `grep -r` across a dehydrated tree triggers zero fetches (test)
- [ ] `artipod commit --layer-group 'dicom/**'` produces a dedicated layer with the `org.artipod.hydration: lazy` annotation (manifest inspection)
- [ ] Interactive hydration preempts a running prefetch (throughput assertion)
- [ ] Agent `prefetch` tool warms a glob's backing layers within budget, visible in `/proc/hydration`
- [ ] Second browser on the LAN pulls the same pod with zero WAN blob fetches (site-cache counters); the cache holds only ciphertext for an encrypted pod
- [ ] `dehydrate` evicts layer blobs but keeps indexes/placeholders; re-hydration round-trips
- [ ] A foreign image without published indexes degrades gracefully (documented: index-level pull unavailable → full pull, or site cache generates indexes)

**Worklog:**

- _(empty)_

### Phase 7 — Live object streams (multiparty, event-driven)

> **Branch** `phase-7-live-streams` · **Status** _stretch — out of initial scope (re-plan before starting)_

Target UX (in spirit): `cat /dev/microphone | nc transcribe.host > transcript.json` — a browser writes recorder media into its pod and the bytes reach the other replicas *as written*, with a hookable stream so subscribers process chunks on arrival (playback, transcription, indexing).

**Two data planes, one store.** The sealed plane (Phase 6) stays as is: immutable digest-addressed blobs, anti-entropy. The live plane adds `ObjectStream`: a **single-writer append-only chunk log** `{streamId, path, seq, offset, bytes, chunkHash}`.

- [ ] **Host ingest API (the primary surface).** Media and files enter the pod programmatically; everything funnels into the same `ObjectStream` machinery (append → replicate → seal → blob):

```ts
// one-shot artifacts (PDF, jpg, finished recordings): File | Blob | Uint8Array | ReadableStream
await pod.put('/context/media/scan.pdf', file);

// live bytes: any WHATWG ReadableStream → pod path (WritableStream returned)
await fetchResponse.body.pipeTo(pod.createWriteStream('/context/media/download.bin'));

// live capture: accepts the MediaStream itself — getUserMedia yields tracks, not bytes,
// so pod.recordMedia wraps MediaRecorder (timeslice → encoded chunks) internally
const media = await navigator.mediaDevices.getUserMedia({ audio: true });
const rec = pod.recordMedia(media, '/context/inbox/visit-001.webm', { timesliceMs: 500 });
// … chunks replicate to subscribed replicas as they are written …
await rec.stop(); // seals: digest → OCI blob → entry in the next snapshot
```

  `put` of a small Blob is a stream that seals immediately — one code path, no special cases. While a stream is open, the file is readable-as-written at its pod path locally (tail-able by local consumers), and `pod.events` reflects growth so the tree/editor update live.

- [ ] **CRDT semantics, stated precisely**: one writer per stream ⇒ the append log is trivially convergent (ordered by the writer's `seq`; no merge law needed). Multiparty = many concurrent streams on **disjoint paths**; the manager grants an advisory write lease per path prefix, so replicas "on the same layer" (sharing a branch head) converge on identical upper content without byte-level merges. Multi-writer to one path remains explicitly unsupported (that's Yjs-in-a-file or a branch).
- [ ] **Resumable + eventually consistent**: subscribers ack offsets; reconnect resumes from last ack; chunk hashes verify segments. On writer close the log **seals**: digest computed → becomes an ordinary OCI blob + path entry in the next snapshot. Replicas that consumed the live stream already hold the bytes — seal is a digest check, not a re-transfer; late joiners fetch the sealed blob via Phase 6 sync.
- [ ] **Manager events over the wire**: extend `pod.events` across managers — `stream:open|data|seal`, `ref:advanced` — relayed via WebSocket/SSE (server-mediated) or WebRTC DataChannel (P2P; `ArtipodPeerTransport` promoted from issue #1's defer list for exactly this). Hookable consumer API: `manager.onStream(pathGlob, handler)` where `handler` gets an async iterable of chunks — the transcriber case is the existing ONNX/whisper worker pattern (`ui` whisperTranscribe) fed from a stream instead of a file.
- [ ] **Pod fs surface**: device files as a `/proc`-framework provider family — `modprobe media` enumerates via `mediaDevices.enumerateDevices()` → one node per physical device, `/dev/audio<N>` / `/dev/video<N>` for inputs and `/dev/speaker<N>` for `audiooutput` sinks (write = playback; sink selection via `setSinkId`), plus `/dev/microphone`, `/dev/camera`, `/dev/speaker` symlinks to the defaults; metadata under `/proc/devices/` (label, kind, groupId, facingMode); re-enumerate on `devicechange`. Browser quirk to surface honestly: labels stay blank until the first `getUserMedia` permission grant. Plus `StreamFS` endpoints where writes append+publish and subscriber reads consume. Device files and `pod.recordMedia` share one capture implementation.
- [ ] **Stretch (gravy): bounded `record` command** — `record -d 10s /dev/video1 /context/media/clip.webm`, implemented as a thin shell over `pod.recordMedia(deviceFromNode, dest, { durationMs })`. Because the duration is bounded, it may block its single `exec` (Ctrl+C aborts via the existing signal path) and return the sealed path + digest; the unbounded form is refused with a pointer to `artipod stream pipe`. Server-side `record` doesn't exist — the device provider is browser-only by nature.
- [ ] **Shell surface (secondary sugar over the same tasks; verified constraint)**: browser `Bash` buffers — custom commands get `ctx.stdin` as a materialized `ByteString` and return one `ExecResult` (`custom-commands.ts`); incremental stdout exists only in the node-only `Sandbox` class, which `just-bash/browser` excludes. So unbounded pipes cannot live inside a bash pipeline. Bridge commands start **host-side stream tasks** and return immediately: `artipod stream pipe /dev/microphone pod://transcriber/inbox/audio.webm`, `artipod stream ls|stop <id>`, live status under `/proc/streams/`. If upstream ever gains incremental command I/O, the literal pipeline form becomes sugar over the same tasks.

**Done when:**

- [ ] Browser records mic → chunks arrive at a subscriber pod → it transcribes as they arrive and writes `transcript.json` back → transcript appears in the browser pod event-driven
- [ ] Kill the tab mid-recording → reopen → transfer resumes from the last acked offset (no gap, no duplicate chunks)
- [ ] After seal, every replica reports the same blob digest with zero re-transfer (verify from transfer logs/counters)

**Worklog:**

- _(empty)_

## 5. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| ZenFS backend API churn between versions | OciLayerFS/OciViewFS rework | Exact-pin zenfs pair in peerDeps (Phase 0); contract tests over the backends |
| Pure-ESM break for unknown CJS consumers | consumer churn at 0.2.0 | web-demo retired; only known consumers (artipod-sync, ui) are ESM; semver-major the package rename to `@artipod/core` |
| Tar/whiteout edge cases (hardlinks, opaque dirs, device nodes) | wrong file views | Port fixtures from containerd/umoci test images; alpine + a crafted whiteout fixture in CI |
| IndexedDB blob-size and quota limits on big layers | pulls fail on browser | stream-to-OPFS for blobs when available; surface `navigator.storage.estimate` like StorageSettings does; depth-limited pulls first |
| Registry CORS/auth from the browser | direct pulls fail | proxy transport is the default (same posture as the git proxy); direct transport is opportunistic |
| Two-repo migration churn (mieweb/artipod ⇄ horner/artipod-sync) | broken intermediate states | re-export shims for one release; workspace `file:` deps during transition; each phase independently shippable |
| just-bash upstream drift (pinned semantics: per-exec isolation, `BASH_ALIAS_*`) | sandbox session breaks | keep the session-contract tests moved in Phase 2; pin just-bash exact |
| Snapshot/manifest schema regret | migration pain later | version every JSON (`formatVersion`), use `application/vnd.artipod.*` media types from day one per issue #1 |
| Long recordings vs. browser quota/backpressure (Phase 7) | dropped chunks, tab OOM | spill chunk log to OPFS, bounded in-memory window, trim below acked offset; surface `storage.estimate` |
| WebRTC NAT/firewall failures for P2P streams (Phase 7) | multiparty falls apart | same chunk protocol over manager relay (WebSocket/SSE) as automatic fallback |
| Encryption complexity stalls core phases | 4–6 slip | formats land in Phase 4 behind a per-pod opt-in flag (default off); keyring/authority isolated in 6.5; core phases never block on crypto |
| Approval fatigue → rubber-stamped sudo | policy erosion | banned classes never prompt; capabilities scoped + TTL'd; audit stream reviewed; approver role is policy-granted, not default |
| Implicit hydration storms (`grep -r` over placeholders) | bandwidth bombs, surprise costs | dehydrated reads fail fast with a hint — hydration only via click/command/prefetch tool; pinned by a zero-fetch test |
| Layer grouping too coarse (one click pulls an oversized layer) | slow first-open, wasted bandwidth | commit-time `--layer-group` guidance (study/dataset per layer) + size warnings at commit; seekable formats later behind `LazyLayer` if it truly hurts |

## 6. Decisions (all resolved 2026-08-30)

1. **`examples/web-demo`: retired** to `attic/` in Phase 0; the build goes pure ESM with no dual-CJS accommodation. Its successor is the Phase 6 north-star demo: demo artipod in the browser → clone into a new pod (or pull) → push/pull changes to the server → snapshot + compact.
2. **`exec-sessions.ts` split by reusability**: the generic part (pod/session hosting, storage config, transports — the *manager*) graduates into `@artipod/core/manager` in Phase 6; the deployment part (Next routes, bearer auth, TTL/rate numbers) stays in artipod-sync. Rule: if a second server app would copy-paste it, it's package; if it's one deployment's policy, it's app.
3. **Mount root: no core-enforced pattern.** Mount placement belongs to the application/harness: every manifest mount declares an explicit `path`, and core/tools/prompts resolve against declared paths without assuming any prefix. `/context/<name>` survives only as the docker realizer's historical default and our own apps' suggested template. Consequence: prompts must always echo the actual mount table (`buildPrompt` + `/proc/pod/manifest.json`) — models cannot rely on a memorized layout.
4. **OCI proxy allowlist: configured at initialization, default deny-all** (constructor/env, like `GIT_PROXY_ALLOWED_HOSTS`). The hosted browser demo enables docker.io + ghcr.io + quay.io.
5. **Agent-turn auto-snapshot: on by default.** Snapshots are references, not copies, so the cost VS Code/Claude Code pay per checkpoint (shadow-copying edited files) doesn't apply, and artipod additionally captures bash side effects they can't. Opt-out flag; `compact` + `gc` bound growth.
6. **Server persistence: the manager decides.** `PodStore` interface with shipped implementations (ZenFS-on-disk, OCI layout dir, remote registry); sync is manager-driven anti-entropy of blobs/refs (convergent, CRDT-style, in any topology). Branch merges stay explicit in v1; Yjs-style live CRDTs remain an in-file concern. The hosted artipod-sync manager ships on the **OCI image-layout directory** store.
7. **npm scope: `@artipod/*`** (org created on npmjs 2026-08-30). Primary package `@artipod/core` (mirrors `@zenfs/core`), published from the `mieweb/artipod` repo; placeholder `0.0.1` reserved immediately, first real release `0.1.0` at the Phase 0 gate. `@artipod/oci-9p` / `@artipod/container2wasm` become siblings when they materialize. The `@artipod/sandbox-web` working name from just-bash-plan is retired.
8. **No AI in tests.** Suites cover the tool/loop *surface area* only: schemas, fs effects, truncation, loop plumbing against scripted fakes. No live model calls, no model downloads, no network; the ONNX `local/` suite stays fully mocked. No default AI endpoint ships — endpoints remain user-configured in the panel.
9. **Scope**: the implementer (horner) executes Phases 0–6.6; Phase 7 is designed but requires re-planning before starting. `feature/vscode-tool-compatibility` merges to `main` before Phase 0 branches.
10. **Agent confinement + sudo policy chain.** The agent is confined to its pod by the tool layer (a real, enforceable boundary — agents act only through tools). `sudo` is the sole escape: agents can never self-approve; a human approval counts only if signed admin policy grants that user the approver role; policy-banned classes fail EPERM without prompting; approvals mint scoped, TTL'd capabilities; all of it audited into pod provenance. Offline access = signed grants; site authority = delegation certificates (rig/interplanetary/relay profiles). Normative: docs/security-model.md + docs/encryption.md.
11. **Docs are authored ahead as the target-state spec** (`README.md` + `docs/{browser,linux,bash-isolate,encryption,security-model,console}.md`), status-bannered ✅/🔮; a PR that diverges from a doc fixes the doc. The v0.1 Node-only README is archived at `attic/v0.1-node.README.md`. The Ctrl+~ console ships as `@artipod/core/console` (Phase 2).
12. **Lazy hydration: the OCI layer is the unit.** Layer indexes ship as small artifacts beside the manifest, so the whole namespace is visible with zero layer blobs; opening a file hydrates its winning layer — whole blob, digest-verified. Heavy data is grouped into dedicated lazy-annotated layers at commit time (`--layer-group`, ideally one study/dataset per layer); notes/FHIR live in eager layers. Plain-OCI compatible (annotations + index artifacts only) — no eStargz/SOCI-style random-access machinery; seekable formats can slot behind the same `LazyLayer` abstraction later if layer granularity proves too coarse. Dehydrated reads fail fast with a hydrate hint — never implicit bulk fetching. Site caches: delegated managers, digest-keyed pull-through, blind for encrypted pods. Lanes: interactive ≻ prefetch (incl. the agent tool) ≻ background.
