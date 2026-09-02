# artipod

**A pod for artifacts: a virtual filesystem your AI can reason in, your users can shell into, and your infrastructure can version, encrypt, and synchronize — in the browser and on Linux.**

> **Status: shipped through plan Phase 6.6.** Everything below marked ✅ ships in `@artipod/core` today — the Node/Docker core, the browser sandbox, OCI layering, encryption & authority, and sync (the browser app lives at [examples/artipod-sync](examples/artipod-sync)). 🔮 marks the remaining design work (Phase 7 live streams), tracked phase-by-phase in [artipod-layer-plan.md](artipod-layer-plan.md). Previous implementation-state READMEs are archived in `attic/` ([v0.1](attic/v0.1-node.README.md), [v0.3](attic/v0.3-node.README.md) — the v0.3 one documents the pre-merge Node/Docker API, including podman support, read-only mounts, and the main mount).

## What is an artipod?

An **artipod** is a self-contained, portable workspace — a declarative set of mounts over a virtual filesystem, plus everything that operates on it:

- a **bash isolate** (real bash semantics, browser and server) ✅
- **AI agent tools** with VS Code-compatible schemas, an agent loop, and context/prompt building ✅
- **OCI layering** for revision control: every pod is image/volume layers + a writable upper; snapshot, checkout, diff, commit, push, pull ✅
- **encryption & authority**: ciphertext at rest, leased keys, offline grants, delegated managers ✅
- **sync**: content-addressed, resumable, relay-friendly — browser ↔ server ↔ home base ✅

Three consumer surfaces, one layer:

| Surface | What it gets |
|---|---|
| **AI reasoning** | `buildPrompt()` context, VS Code-schema tools (`read_file`, `apply_patch`, …, `bash`), agent loop, `/proc` introspection — all confined to the pod |
| **Revision control** | OCI snapshots: cheap (reference-based) checkpoints of *everything*, including shell side effects; time-travel, branch, diff, compact |
| **Synchronization** | push/pull of digest-addressed layers through registries, proxies, or relays; offline-first by construction |

> **Coming from Docker or Podman?** The muscle memory transfers (`artipod run -it alpine:3.22`, `artipod pods`), but the model inverts: in Docker the image is the artifact and the container's writable layer is scratch; here the writable state *is* the artifact — versioned, encrypted, pushable. And a pod is **not a Kubernetes Pod** — it's durable state that execution attaches to, not scheduled compute. Full orientation and concept map: [docs/containers.md](docs/containers.md).

## Quick starts

### The CLI: a pod in your terminal (✅)

```sh
npx artipod run -it              # fresh pod → artipod-bash, kept under ~/.artipod/pods
npx artipod run -it alpine:3.22  # a registry image, cloned in writable
npm install -g artipod           # permanent `artipod` on PATH (alias for @artipod/core)
artipod pods                     # past runs — the `docker ps -a` of pods
artipod run -it 500edf8b         # resume a kept pod by id prefix
artipod run -it field/notes:1    # a ref you pushed earlier
```

(`npx github:mieweb/artipod` also works — it compiles from source on first run and caches.)

Pods are kept on the real filesystem by default, so `exit` loses nothing — create-on-write: a
fresh pod that saw no writes is quietly removed again. `--rm` makes the pod ephemeral (RAM only
— add `--disk` to back it by a deleted-on-exit temp dir when changes may not fit in memory),
`artipod rm <pod>` / `artipod prune` clean up kept pods, `--dir <path>` keeps a pod at a path of
your choosing, `--store <path>` (default `~/.artipod/store`) backs `push`/`pull`/`clone` and REF
lookup, `-c '<cmd>'` runs one line and exits. Inside the shell, `artipod` lists the pod verbs
(snapshot, commit, push, hydrate, …).

### Browser pod with a shell (✅ `@artipod/core/sandbox`)

```ts
import { initFileSystem, createSandbox } from '@artipod/core/sandbox';

const { zfs } = await initFileSystem();     // IndexedDB (default) or OPFS
const sandbox = createSandbox({ zfs });     // just-bash over ZenFS
const r = await sandbox.exec('git clone https://github.com/user/repo && ls repo | head');
```

### Linux / server pod with Docker/Podman execution (✅ core shipped)

```ts
import { ArtiPod, ArtiMount } from '@artipod/core';

const pod = new ArtiPod({
  workspaceDir: '/data/workspaces',                    // auto-creates the writable 'main' mount
  mounts: [new ArtiMount('src', '/data/project/src', /* readonly */ true)],
});
await pod.initialize();
await pod.startContainer('./container/Dockerfile');   // hardened: CapDrop ALL, seccomp, no network
const out = await pod.executeCommand('grep -r TODO /context/src | wc -l');
```

See [docs/linux.md](docs/linux.md) for the full server story (realizers, OCI-layout store, systemd).

### An agent working inside a pod (✅ `@artipod/core/agent`)

```ts
import { createToolRegistry } from '@artipod/core/tools';
import { ToolCallingLoop } from '@artipod/core/agent';

const tools = createToolRegistry(pod);      // read_file, apply_patch, bash, … — pod-confined
const loop = new ToolCallingLoop(client, tools);
await loop.run('Summarize the README, then fix the failing test.');
// tool-executing turns auto-snapshot (pod.agentLoopOptions(), default on) — `artipod snapshot diff` shows what the model did
```

The agent is **confined to the pod**. Anything outside it requires `sudo` — which the agent cannot self-approve. See [docs/security-model.md](docs/security-model.md).

### The Ctrl+~ console (✅)

One line to give any web app a drop-down artipod console (Quake-style):

```ts
import { installConsole } from '@artipod/core/console';
installConsole({ sandbox, hotkey: 'Ctrl+`' });   // Ctrl+` / Ctrl+~ toggles the overlay
```

See [docs/console.md](docs/console.md).

## Package layout

Single package, ESM subpath exports (browser/node split via export conditions):

```
@artipod/core            ArtiPod, ArtiMount, pod manifest, pod events
@artipod/core/tools      VS Code-schema tools + bash, OpenAI & MCP serializers
@artipod/core/prompts    prompt templates + buildPrompt
@artipod/core/sandbox    just-bash isolate, ZenFS adapter, storage backends
@artipod/core/agent      tool-calling loop, OpenAI-compatible + local ONNX clients
@artipod/core/proc       /proc providers (host state as files)
@artipod/core/host       headless UI controllers (terminal session, file buffer, tree)
@artipod/core/console    Ctrl+~ drop-in overlay console
@artipod/core/manager    pod hosting, PodStore, keyring, leases, policy
@artipod/core/server     fetch-style hosting handlers: pod store, exec, git/OCI proxies (node-only)
@artipod/core/oci        blob store, layer FS, snapshots, transports
@artipod/core/docker     hardened Docker execution (node-only)
```

## Security model in five lines

1. **Disk holds only ciphertext + wrapped keys**; usable keys live in a memory keyring, on server-issued leases with a TTL. Lock = the key evaporates; login restores it.
2. **Offline is first-class**: signed offline grants (e.g. 24 h) wrap keys to a device; delegated manager certificates let a ship/station/site issue leases with no home-base round trip.
3. **The agent is confined to its pod.** `sudo` is the only escape, it requires explicit human approval, and the human may only approve if admin policy grants them that right.
4. **Relays never need plaintext** — content addressing verifies end-to-end, so untrusted hops can cache and forward.
5. Honesty: a browser can enforce cryptography, not process boundaries — see the threat-model tables in [docs/encryption.md](docs/encryption.md) before assuming more.

Built for real disconnection profiles: a 24-hour offline clinic visit, a light-minutes-away station where all operations are local and sync is merely delayed, and an intermittently-connected ship where laptops relay through an on-board server. Walkthroughs in [docs/encryption.md](docs/encryption.md#offline-use-cases).

## Documentation

| Doc | Contents |
|---|---|
| [docs/containers.md](docs/containers.md) | Orientation for Docker/Podman/Kubernetes users: concept map, where each runtime fits, the pod-term collision |
| [docs/on-disk-layout.md](docs/on-disk-layout.md) | What lands on disk: `~/.artipod`, the per-pod `/.artipod` store, plaintext vs ciphertext |
| [docs/browser.md](docs/browser.md) | Browser implementation: ZenFS backends, OPFS/IndexedDB, ingest API, devices |
| [docs/linux.md](docs/linux.md) | Linux/server implementation: realizers, Docker hardening, stores, deployment |
| [docs/bash-isolate.md](docs/bash-isolate.md) | The bash isolate in browser and server: semantics, sessions, limits |
| [docs/encryption.md](docs/encryption.md) | Encryption at rest, keyring, leases, offline grants, delegation |
| [docs/security-model.md](docs/security-model.md) | Agent confinement, `sudo`, approval flow, admin policy |
| [docs/console.md](docs/console.md) | The Ctrl+~ installable console module |
| [artipod-layer-plan.md](artipod-layer-plan.md) | The living implementation plan (phases, decisions, worklogs) |

## License

MIT
