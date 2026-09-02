# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.0] - 2026-09-02

### Added

- **`artipod serve`** ([docs/serve.md](docs/serve.md)): one process, one OCI-layout store, three surfaces — the browser UI at `/`, the native sync API at `/api`, and a real OCI Distribution registry at `/v2` (pull *and* push; the conformance suite runs in CI). `--publish <dir>` snapshots folders at boot and materializes pushed heads back into them; `--cors`, `--oci-allow`, `--only web|registry`, `--open` shape the deployment. Default port 2784 ("ARTI").
- **Embeddable app**: `createArtipodApp({ store, … })` is a single WinterCG fetch handler — mount it in Next.js, Hono, Bun/Deno, or the bundled node adapter (`serveApp`). The CLI runs the same object.
- **Tokens (V7/S5)**: localhost stays open; a non-localhost bind with no token generates one (Jupyter-style). `--token` (rw) and `--read-token` (ro) accept Bearer or Basic — `docker login` works.
- **Sealed tags — enforced by default** ([docs/dossier.md](docs/dossier.md)): tags not starting with `_` are **create-once** — the push that creates them lands, every later move or delete is 403 on both write surfaces. `_`-tags are open drafts (mutable, deletable, collaborative). `--seal-pattern <re>` narrows the rule, `--no-seal` restores classic mutable tags, `--lock`/`--unlock <ref>` add explicit per-ref locks (persisted in `<store>/locks.json`). `--publish` folder refs are exempt (write-back is their point). The refs API marks sealed entries `locked` so UIs can drop write affordances up front.
- **Tag delete**: `DELETE /v2/<name>/manifests/<tag>` and `DELETE /api/pods/refs?name=` retire a ref pointer (blobs and the parents DAG stay) — refused with 403 for sealed tags. `PodStore` gains optional `deleteRef`.
- **`artipod publish [<name:tag>]`** (pod verb + `publish` alias in the demo shell): push the workspace to the server. A blank workspace publishes under a new name; an opened ref pushes back with no argument or **publishes-as** a new ref sharing every basis layer (content-addressed — nothing re-uploads). `pushOverlay` gains `permanent` for publish flows, so a later empty overlay push can never strip published layers.
- **Demo: catalog + modes** ([examples/artipod-sync](examples/artipod-sync)): `/` lists the server's refs (manifest digest chip, locked badge, per-ref `rw`/`cow`/`ro` open modes) and this machine's workspaces; cow forks persist across tabs in their own upper; publish buttons in the File Explorer and Layers views, one-step "create & publish" for new workspaces, and content-based reconciliation that recognizes a published blank as its server ref and retires the local copy.
- **Terminal line editing**: Ctrl+A/E, Home/End, arrows, forward Delete, mid-line insert, and Ctrl+R reverse-i-search over history in the pod terminal (`TerminalSession`).
- **The dossier pattern** ([docs/dossier.md](docs/dossier.md)): entities (patients, cases, customers, tickets) as repositories, open workstreams as `_` sigil tags, sealed milestones as create-once tags, per-workstream folders as the concurrency policy, and late-binding identity as a merge. Plus [docs/multi-tab.md](docs/multi-tab.md) on browser multi-tab semantics.

### Changed

- **Loopback registry refs use plain HTTP**: `artipod run 127.0.0.1:2784/ref` pulls from a local serve without TLS ceremony.

## [0.7.1] - 2026-09-02

### Fixed

- **Sandbox `git clone` now behaves like real git**: it clones into a subdirectory derived from the URL (last path segment, minus `.git`) instead of the shell's cwd, honors an explicit target-directory argument (relative or absolute), and refuses a non-empty destination with git's wording.

## [0.7.0] - 2026-09-02

### Added

- **`artipod import <dir> <name:tag>`**: snapshot a host folder into the store as an image ref without booting a pod — per-file layers with CAS dedup, so re-importing an unchanged tree is a no-op and only changed files cost bytes. `artipod run -it <name:tag>` materializes it at `/` like any other volume ref.
- **`artipod run --base <dir>[:<podpath>]`** (repeatable): import a folder at boot and materialize it into the pod (default `/`). Folders stack in order — later `--base` wins on conflicts, the stack sits on top of REF when one is given — and committing inside the shell freezes the merged result as a layer.
- **`artipod run -v <dir>:<podpath>[:ro|:cow]`** (repeatable): docker-style LIVE host mount. Default rw writes back to the real folder; `:cow` keeps writes in RAM so the host is never touched; `:ro` marks the mount read-only for the tool layer and keeps it out of commit roots. The target is mandatory and `/` is refused.

### Changed

- **Releases publish both packages via npm trusted publishing**: the GitHub Release workflow now publishes `@artipod/core` and then the `artipod` CLI alias with OIDC (no token secret), skipping versions already on the registry so re-created releases are safe.

## [0.6.0] - 2026-09-01

### Added

- **`less` and `more` in the pod shell**: seeded as `cat` aliases (the sandbox has no TTY, so they print rather than page). They list via `alias`, tab-complete, and stay user-overridable — `unalias`/redefinition stick across lines.

### Changed

- **`artipod prune` spares tagged pods** (docker dangling-image semantics): only pods without a committed tag are pruned; `-a`/`--all` removes tagged ones too. `artipod pods` grew a TAGS column, and exiting an interactive session now prints how to get back (`artipod run -it <id>`) and, for untagged pods, that prune would remove them.

### Security

- **All dependabot alerts cleared (173 → 0 across every manifest)**: non-breaking `npm audit fix` everywhere, plus targeted `overrides` for transitives whose parents ship no fixed release (dockerode→uuid 11, onnxruntime-node→adm-zip 0.6, transformers→sharp 0.35, minimatch@9→9.0.7, monaco→dompurify 3.4.13, next→postcss 8.5.23). The `examples/artipod-sync` demo moved to Next 15.5 + React 19 — Next 14 never received backports for ~20 high-severity advisories (DoS/SSRF/cache poisoning) — with the Next-15 async `params` migration and the `serverExternalPackages` rename. The attic web-demo's stale lockfiles are deleted (dead code, 26 alerts).

## [0.5.0] - 2026-09-01

### Changed

- **`dockerode` is now an optional peer** (was a hard dependency): `npx artipod` and plain installs no longer pull the docker client (46 packages and npm's `uuid@10` deprecation warning) — `npm install dockerode` to use the `/docker` execution backend. Using it without the peer now fails with an error that says exactly that.

## [0.4.0] - 2026-09-01

First npm release as [`@artipod/core`](https://www.npmjs.com/package/@artipod/core).

### Added

- **`npx artipod`**: the bare `artipod` npm package ([packages/artipod](packages/artipod)) is an alias whose bin runs `@artipod/core`'s CLI in-process — same versions, published alongside core.

- **`artipod pods`**: list kept pods (pod id, created, last used, size), newest first — the `docker ps -a` of pods. `--pods <path>`/`ARTIPOD_PODS` overrides the root.
- **`artipod rm <pod>...` and `artipod prune`**: delete kept pods by id (unique prefix ok) or wipe them all; prune asks first unless `-f`, and both only touch dirs carrying a pod superblock.
- **Build provenance in `--version`/`--help`**: the build bakes `dist/buildinfo.json` (commit hash, `-dirty` when the tree had changes, commit date) and the CLI reports `artipod <version> (<commit>, <date>)`. The version auto-bumps from git tags — `0.3.1+5` means 5 commits past tag 0.3.1 — so every push moves it without touching package.json.

### Changed

- **CLI pods are kept by default**: `artipod run` now keeps each pod under `~/.artipod/pods/<pod-id>` so past runs survive exit; `artipod run -it <pod-id>` resumes one (unique id prefix ok). `--rm` restores the old throwaway behavior (RAM only); `--rm --disk` backs the ephemeral pod by a deleted-on-exit temp dir for working sets bigger than memory. Create-on-write: a fresh pod that saw no writes during the run is removed again at exit, so read-only sessions leave no clutter.

## [0.3.0] - 2026-01-15

### Added

- **Tool registries for AI integration**: New tool registry system compatible with OpenAI function calling and vscode-copilot-chat
  - `MountToolRegistry`: File operation tools (read_file, write_file, create_file, apply_patch, etc.)
  - `PodToolRegistry`: Container command execution tools
- **run_in_terminal tool**: Execute bash commands in sandboxed containers with optional timeout override
  - Commands run in `/context` directory with all mounts accessible at `/context/<mount-name>`
  - Configurable timeout (1s-5min range, default 30s)
  - Exit code-based success determination (`exitCode === 0`)
  - Full bash support (pipes, redirects, cd commands, etc.)
- **Container environment documentation**: Comprehensive documentation of security sandbox, resource limits, and execution context
- **Timeout override support**: `ArtiPod.executeCommand()` now accepts optional timeout parameter

## [0.2.0] - 2026-01-09

### Added

- **Auto-generated main mount**: ArtiPod can now automatically create a writable "main" mount when initialized with `useMainMount: true` (default). This provides a dedicated workspace directory for each pod at a predictable path: `{workspaceDir}/artipod-{id}`
- **Explicit persistence model**: ArtiPod now requires all mounts to be provided explicitly when re-instantiating from persisted state. This eliminates hidden coupling and makes the persistence contract clear.

### Changed

#### Breaking: ArtiPod constructor and persistence behavior

**What changed**:

1. **New `useMainMount` option in ArtiPodOptions**
   - When `true` (default), automatically creates a writable "main" mount
   - When `false`, no automatic mount is created
   - **Important**: Only used during initial pod creation, not when reloading

2. **Explicit reload pattern required**
   - When reloading a persisted pod, you must provide ALL mounts explicitly (including any auto-created main mount)
   - Set `useMainMount: false` when reloading to avoid conflicts
   - Applications must store complete mount information (name, path, readonly flag) in their persistence layer

3. **'main' mount name is not special**
   - After creation, a main mount is treated like any other mount
   - You can manually create a mount named "main" with `useMainMount: false`

**Usage pattern**:

```typescript
// Initial creation - auto-creates main mount
const pod = new ArtiPod({ 
  id: 'my-pod-123',
  workspaceDir: '/path/to/workspaces',
  useMainMount: true  // Creates main mount at /path/to/workspaces/artipod-my-pod-123
});
await pod.initialize();

// Store in database: ALL mounts including main
// mount_name: 'main', mount_path: '/path/to/workspaces/artipod-my-pod-123', readonly: false

// Later, reload from database - provide all mounts explicitly
const mainMount = new ArtiMount('main', '/path/to/workspaces/artipod-my-pod-123');
const docsMount = new ArtiMount('docs', '/path/to/docs', true);  // readonly
const pod = new ArtiPod({
  id: 'my-pod-123',
  useMainMount: false,  // Don't auto-create; providing explicitly
  mounts: [mainMount, docsMount]
});
await pod.initialize();
```

**Benefits**:
- No hidden coupling between pod IDs and filesystem paths
- Path generation schemes can change without breaking existing pods
- Full explicitness - everything needed to recreate a pod is stored in your persistence layer
- Clear contract - you control and store all mount information

## [0.1.3] - 2026-01-08

### Added

- **Read-only mounts**: ArtiMount now supports a `readonly` option in the constructor. When set to `true`, write operations (`write()` and `createFolder()`) will throw errors. This allows mounting directories that should not be modified.

```typescript
// Create a read-only mount
const readOnlyMount = new ArtiMount('docs', '/path/to/docs', true);
await readOnlyMount.initialize();

// Attempting to write will throw an error
await readOnlyMount.write('file.txt', 'content'); 
// Error: "Cannot write to read-only mount 'docs'"
```

## Previous releases

See git history for changes prior to 0.1.3.
