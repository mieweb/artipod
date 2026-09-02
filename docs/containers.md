# Coming from Docker, Podman, or Kubernetes

> **Status: orientation, not design.** Everything referenced here ships today (✅ in the [README](../README.md)) unless marked 🔮. This doc maps artipod onto container-world vocabulary; the implementations live in [linux.md](linux.md), [browser.md](browser.md), and [encryption.md](encryption.md).

artipod lives in the **OCI world, not the orchestration world**. It reuses the container ecosystem's *artifact* model — images, layers, digests, registries — and inverts its *runtime* model: the durable thing is the workspace, and execution is a pluggable attachment.

## The one inversion to internalize

In Docker, the **image** is the artifact and the container's writable layer is disposable scratch — `docker commit` exists but is an anti-pattern, and everyone learns to shove state into volumes. In artipod, **the writable state is the artifact**: a pod is image/volume layers plus a writable upper, and snapshotting, diffing, committing, encrypting, and pushing that upper is the whole point.

Consequences:

- `docker` containers persist after exit, but nobody cares — the writable layer is second-class. `artipod run` keeps the pod because the pod *is* the product; `--rm` opts out.
- `docker commit` is frowned upon; `artipod commit --tag` is the workflow. It freezes the workspace into a first-class **volume image** (config media type `application/vnd.artipod.volume.v1+json`) in a standard OCI image manifest.
- You push images, never containers. artipod pushes **pods** — as ordinary OCI layers, missing digests only, resumable, through registries or blind relays.
- Think *`git` for filesystem state, spelled like `docker`*: `snapshot create` ≈ commit, `snapshot checkout` materializes a new writable branch (HEAD never moves, history is never destroyed), `compact` ≈ squash.

## Concept map

| Docker/Podman | artipod | Notes |
|---|---|---|
| image | image | the same OCI images, pulled from the same registries |
| container | pod, roughly | but durable, versioned, and portable across execution backends |
| container writable layer | the pod's writable upper | snapshot/diff/commit/push instead of scratch |
| named volume | the closest analog to a pod | except versioned, encrypted, syncable |
| bind mount (`-v`) | `ArtiMount` / a manifest mount declaration | each pod carries a declarative mount table ([linux.md](linux.md)) |
| `docker ps -a` | `artipod pods` | |
| `docker run -it alpine` | `artipod run -it alpine:3.22` | same muscle memory on purpose |
| `docker diff` | `artipod snapshot diff` | |
| `docker commit` | `artipod commit --tag` | first-class, not a hack |
| `docker push` / `pull` | `artipod push` / `pull` | content-addressed; relays never need plaintext |
| `docker system prune` | `artipod gc` | mark-and-sweep of unreachable blobs, with byte accounting |
| registry | registry, manager, or relay | the on-disk store is an **OCI image-layout directory** — inspect it with `skopeo` or `crane` |
| dockerd | no daemon required | browser pods run on a bash isolate: no daemon, no VM, no extension |

## Where Docker and Podman literally fit

Docker/Podman is one of three execution backends a pod can attach to — the pod outlives whichever one you use:

1. **just-bash isolate** ✅ — real bash semantics over a virtual FS, browser and server, zero infrastructure ([bash-isolate.md](bash-isolate.md)).
2. **Docker/Podman realizer** ✅ — real container execution for pods whose mounts are host directories ([linux.md](linux.md)).
3. **container2wasm via 9P** 🔮 — a full Linux VM in WASM, unscheduled.

The realizer speaks the Docker API (via dockerode, an optional peer — `npm install dockerode` to enable this backend) and auto-detects sockets in this order: **rootless Podman first** (`$XDG_RUNTIME_DIR/podman/podman.sock`), rootless Docker, then the macOS user sockets (Docker Desktop, Colima, Lima, Rancher Desktop, Podman machine), and rootful Podman/Docker only as fallbacks. Containers are hardened by default and this must not regress: `CapDrop ALL`, read-only rootfs, `no-new-privileges`, private IPC, `NetworkMode: none`, noexec tmpfs, memory/CPU/pids limits, optional seccomp allowlist ([container/](../container/)).

One honest constraint: Docker cannot bind-mount a *virtual* (browser-synced) mount. The pattern is sync the pod to a server, materialize it on disk, then run the container job — a manifest with virtual sources fails fast on this realizer.

Note for Podman users: `podman pod` implements Kubernetes-style pods; an artipod pod is unrelated. When artipod uses Podman, it uses it purely as a hardened container runtime.

## "Pod" ≠ Kubernetes Pod

The terms are near-inverses. A Kubernetes Pod is ephemeral **compute** with storage attached; an artipod pod is durable **state** with compute attached. The nearest k8s analog to an artipod pod isn't a Pod at all — it's closer to *PersistentVolume × image × devcontainer workspace*, with git-like history.

| | Kubernetes Pod | artipod pod |
|---|---|---|
| Unit of… | scheduling — co-located containers | state — a mount table over a virtual FS |
| Lifetime | ephemeral by design; controllers replace it | durable by default; `exit` loses nothing |
| Identity | transient name/IP | stable id, refs, digest history |
| Storage | attached via volumes | *is* the pod; execution attaches to it |
| Versioning | none — you version images, not Pods | first-class: snapshot, diff, commit, push, pull |
| "push a pod" | not a thing | the core workflow |

If you carry the k8s intuition in ("pods are cattle"), you'll get the lifecycle exactly backwards. Leave it at the door; bring your OCI intuition instead — that one transfers completely.

## Fitting artipod into a Kubernetes shop

artipods are **data plane, not workload plane**. They flow through the OCI registries your cluster already runs; nothing about them needs to be scheduled.

- The **manager** ([linux.md](linux.md)) is an ordinary long-running service — run it as a Deployment, a systemd unit, whatever you deploy Node services with. It hosts pods, serves sync, issues key leases, and can act as a site pull-through cache.
- A k8s Pod (or CI job, or bare VM) can *host* pods: run the manager or a Docker-realizer job inside it. Yes, that means "the pod's pods" — in mixed company, say **artipod**.
- Registries, `skopeo`, `crane`, digest pinning, pull-through caches: all of it applies unchanged, because the store *is* an OCI layout.

## "I already have Docker — why bother?"

What a pod gives you that a container + volume doesn't:

- **Runs where Docker can't**: the same pod, shell, and agent tools work in a browser tab — no daemon, no VM ([browser.md](browser.md)).
- **Revision control for runtime state**: cheap reference-based snapshots of *everything*, including shell side effects; time-travel, branch, diff ([README](../README.md)).
- **Encryption as a property of the data**: ciphertext at rest, leased keys, offline grants — not a property of the host ([encryption.md](encryption.md)).
- **Sync built for bad networks**: digest-addressed, resumable, relay-friendly, offline-first ([sync.md](sync.md)).
- **Agent confinement**: AI tools are scoped to the pod, with `sudo` as the only human-gated escape ([security-model.md](security-model.md)).
