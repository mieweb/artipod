# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`npx artipod`**: the bare `artipod` npm package ([packages/artipod](packages/artipod)) is an alias whose bin runs `@artipod/core`'s CLI in-process — same versions, published alongside core.

## [0.4.0] - 2026-09-01

First npm release as [`@artipod/core`](https://www.npmjs.com/package/@artipod/core).

### Added

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
