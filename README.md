# artipod

![curb weight](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmieweb%2Fartipod%2Fweigh-ins%2Fbadge.json) ![tools entry](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmieweb%2Fartipod%2Fweigh-ins%2Fbadge-bundle-tools-gzip.json)

**A pod for artifacts: a virtual filesystem your AI can reason in, your users can shell into, and your infrastructure can version, encrypt, and synchronize — in the browser and on Linux.**

> **Status: shipped through plan Phase 6.6.** Everything below marked ✅ ships in `@artipod/core` today — the Node/Docker core, the browser sandbox, OCI layering, encryption & authority, and sync (the browser app lives at [examples/artipod-spa](examples/artipod-spa)). 🔮 marks the remaining design work (Phase 7 live streams), tracked phase-by-phase in [plan/artipod-layer-plan.md](plan/artipod-layer-plan.md). Previous implementation-state READMEs are archived in `attic/` ([v0.1](attic/v0.1-node.README.md), [v0.3](attic/v0.3-node.README.md) — the v0.3 one documents the pre-merge Node/Docker API, including podman support, read-only mounts, and the main mount).

## What is an artipod?

An **artipod** is portable artifact state, exposed as a workspace through a declarative set of filesystem mounts. The pod is the data; the software that mounts, synchronizes, or executes against it is separate.

### Artifact format versus services

| Layer | What it describes | What it does not imply |
|---|---|---|
| **Artipod artifact format** | Files and metadata, represented today by OCI manifests, content-addressed layers, refs, and optional encrypted storage | A running server, agent, or synchronization connection; this is an artifact layout, not a single-file extension |
| **Mount and runtime libraries** | Concrete sources, mount paths, access modes, and execution through a shell, browser app, or container | That every pod contains executable code or can choose its own permissions |
| **Synchronization services** | Transfer of blobs and refs between stores, lazy hydration, and reconciliation of saved changes | Remote execution or access to another pod merely because it lives on the same server |
| **Authority and hosting services** | Key leases, authorization, and endpoints supplied by a trusted host | Permissions embedded in or self-granted by a downloaded artifact |

The artifact can exist without any of these services running. OCI is the current snapshot and distribution representation, not a requirement that a live workspace use one particular storage backend. See the [on-disk format](docs/on-disk-layout.md).

The synchronization capability is called **Artipod sync** here, with **encrypted sync** describing its use with encrypted pod content, not a separate product or file format. HTTPS protects transport; pod encryption protects stored content. A blind relay can synchronize ciphertext without decryption keys; server-side processing requires a separately authorized decryption grant. See [sync](docs/sync.md) and [encryption](docs/encryption.md).

`@artipod/core` supplies the libraries for these capabilities. `artipod serve` assembles a reference host; applications can embed the APIs in their own services. The implementation includes:

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

### What Artipod owns

Artipod manages durable pod state and execution attached to that state. Its Docker backend runs commands against pod mounts; it is not a general HTTP application host or a Cloudflare Containers lifecycle adapter. Application routing, scaling, deployment, and production access policy belong to the embedding application, such as `mieweb/cloud`.

[`artipod serve`](docs/serve.md) is a quick POC and reference host for Artipod capabilities, not the prescribed production deployment system. Reuse the library APIs in your own host where appropriate. See the [container orientation](docs/containers.md#execution-versus-application-hosting) for the ownership boundary.

### Pod kinds: data, applications, and agents

These names describe a pod's purpose, not different storage engines or a class inheritance hierarchy. All use the same underlying Artipod mechanisms.

| Kind or convention | Contains | How it is used |
|---|---|---|
| **Artipod** | Any collection of artifacts, such as documents or generated drafts | Mounted as data; execution is optional |
| **AppPod / SPAPod** | Application assets and an entrypoint | AppPod is a descriptive umbrella here; `SPAPod` is the currently supported browser executable kind |
| **CasePod / PatientPod** | Subject data, such as visits, recordings, labs, and notes | Selected independently of its viewer; PatientPod is a domain convention, not a distinct runtime |
| **AgentPod** | Agent instructions, skill references, and capability requests | Loaded by a host-owned harness; model credentials and actual tool grants stay outside the artifact |
| **SkillPod** | Instructions for a particular task | Consumed by an agent harness; guidance does not grant permissions |

A semantic descriptor says what a pod is and what it requests. The concrete `PodManifest` says where authorized sources are mounted and whether they are read-only, copy-on-write, or read-write. The host resolves the former into the latter; declaring a mount does not authorize it.

**Status:** browser SPAPod launch is implemented, but compatible subject selection and AgentPod definition loading are not integrated end to end. PatientPod and SkillPod composition below are illustrative conventions. See the [composition design](plan/model-exec-poc.md#5-multiple-applications-and-composition) and [browser runtime limits](docs/apps.md#trust-and-current-limits).

### Example: dictation with separate browser and server agents

**Hypothetical workflow, not a shipped dictation application.** A clinician uploads a recording into a PatientPod in the browser, reviews spelling suggestions from a browser agent, and synchronizes saved patient files to the server. The clinician has no access to the server's AgentPod or general agent invocation API.

```text
CLINICIAN'S BROWSER                         SERVER

Dictation App                              PatientPod store
  | upload audio and save transcript          ^
  v                                           |
PatientPod working copy --- encrypted sync ------+
  ^                                           |
  | transcript only                           | authorized submitted snapshot
Browser Spellcheck Agent                    Server Clinical Agent
  |                                           |
  +-- suggestions for clinician review        +-- private processing results
```

Each execution environment gets its own logical mount table. These paths are examples, not prescribed paths or launcher syntax:

| Environment | Mount | Source and access |
|---|---|---|
| Browser dictation app | `/app` | Approved SPAPod assets, read-only |
| Browser dictation app | `/patient` | Selected PatientPod working copy, read-write |
| Browser spellchecking harness | `/agent` | Admitted spellchecking AgentPod, read-only |
| Browser spellchecking harness | `/input` | Selected transcript only, read-only |
| Browser spellchecking harness | `/suggestions` | Session-local proposed corrections, read-write |
| Server processing harness | `/agent` | Server-private clinical AgentPod, read-only |
| Server processing harness | `/input` | Submitted patient dictation snapshot, read-only |
| Server processing harness | `/output` | Separate server-owned result storage, read-write |

1. The app saves the recording under `/patient/dictations/visit-7/recording.webm`. A separately configured transcription step supplies `transcript.txt`; uploading audio alone does not produce text.
2. The browser harness uses a local browser model to suggest spelling corrections. The clinician reviews them, and the app saves accepted text as `corrected.txt`. A browser harness using a remote model would instead disclose the supplied text to that provider and needs separate consent.
3. Artipod sync transfers saved PatientPod content, including audio and transcripts. Neither AgentPod nor temporary suggestions are included in that patient artifact. Offline changes can synchronize when connectivity returns.
4. Explicit submission identifies a complete, immutable snapshot for a server-owned job policy. Sync alone does not invoke an agent. The server must verify that the job's input is available before processing it.
5. The server harness receives its own data authorization and decryption grant. The clinician's sync credentials do not permit listing, mounting, editing, or directly invoking the server agent. Results become clinician-visible only through an explicitly authorized publication step.

**The boundary is authorization, not the sync connection.** A blind storage server cannot process plaintext. An authorized processing endpoint can, without exposing its agent definition or credentials to the browser. Browser apps currently execute as trusted same-origin code, so their logical mounts are not a hostile-JavaScript security boundary; server privacy must be enforced by server authorization. Agent tool scopes must also be enforced by the harness, not merely described in instructions.

## Quick starts

### The CLI: a pod in your terminal (✅)

```sh
npx artipod run -it              # fresh pod → artipod-bash, kept under ~/.artipod/pods
npx artipod run -it alpine:3.22  # a registry image, cloned in writable
npm install -g artipod           # permanent `artipod` on PATH (alias for @artipod/core)
artipod pods                     # past runs — the `docker ps -a` of pods
artipod run -it 500edf8b         # resume a kept pod by id prefix
artipod run -it field/notes:1    # a ref you pushed earlier
artipod import ~/proj team/proj:1            # folder → image in the store (no pod)
artipod run -it --base ~/skel --base ./patches   # stack folders as layers (later wins)
```

(`npx github:mieweb/artipod` also works — it compiles from source on first run and caches.)

Pods are kept on the real filesystem by default, so `exit` loses nothing — create-on-write: a
fresh pod that saw no writes is quietly removed again. `--rm` makes the pod ephemeral (RAM only
— add `--disk` to back it by a deleted-on-exit temp dir when changes may not fit in memory),
`artipod rm <pod>` deletes kept pods and `artipod prune` removes the untagged ones (`-a` for
all; tag inside the shell with `artipod commit --tag <name>:<tag>`), `--dir <path>` keeps a pod
at a path of your choosing, `--store <path>` (default `~/.artipod/store`) backs
`push`/`pull`/`clone` and REF lookup, `-c '<cmd>'` runs one line and exits. Inside the shell,
`artipod` lists the pod verbs (snapshot, commit, push, hydrate, …).

Host folders enter the layer model two ways. `artipod import <dir> <name:tag>` snapshots a
folder into the store as an image ref without booting a pod — content-addressed, so
re-importing an unchanged tree is a no-op and only changed files cost bytes; `artipod run -it
<name:tag>` then materializes it like any other ref. `--base <dir>[:<podpath>]` does the
import at boot and materializes the folder into the pod (default target `/`); repeat it to
stack folders in order — later `--base` wins on conflicts, and the stack sits on top of REF
when one is given. Neither ever writes back to the host folder, and committing inside the
shell freezes the merged result as a layer whose parent chain records the imported bases.

For a *live* window onto the host instead of a snapshot, `-v <dir>:<podpath>[:ro|:cow]`
mounts a folder docker-style (repeatable): rw by default (writes inside the shell land in the
real folder), `:cow` keeps writes in RAM so the host is never touched, `:ro` marks it
read-only for the tool layer and keeps it out of commits. rw/cow mounts are commit roots —
mount under `/mnt` (commit-excluded) when it's just source material to copy from.

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
| [docs/multi-tab.md](docs/multi-tab.md) | Multi-tab concurrency: shared cow uppers, per-tab caches, last-write-wins hazards, Yjs/SharedWorker roadmap |
| [docs/linux.md](docs/linux.md) | Linux/server implementation: realizers, Docker hardening, stores, deployment |
| [docs/bash-isolate.md](docs/bash-isolate.md) | The bash isolate in browser and server: semantics, sessions, limits |
| [docs/encryption.md](docs/encryption.md) | Encryption at rest, keyring, leases, offline grants, delegation |
| [docs/security-model.md](docs/security-model.md) | Agent confinement, `sudo`, approval flow, admin policy |
| [docs/dossier.md](docs/dossier.md) | The dossier pattern: long-lived entities (patients, cases, customers, tickets) with open workstreams and sealed, immutable milestones |
| [docs/console.md](docs/console.md) | The Ctrl+~ installable console module |
| [plan/artipod-layer-plan.md](plan/artipod-layer-plan.md) | The living implementation plan (phases, decisions, worklogs) |

## License

MIT
