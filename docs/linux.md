# Linux / server implementation

> **Status: mixed.** ✅ Hardened Docker execution, seccomp profile, and the Node core ship in this repo today; ✅ server bash sessions + git proxy ship in artipod-sync. 🔮 Realizers, OCI-layout store, and the manager land in plan Phases 3–6.

On Linux, artipod runs as ordinary Node — same `@artipod/core` code as the browser, different realizations of storage and execution.

## Storage: three PodStore options (manager's choice)

| Store | Backing | When |
|---|---|---|
| **OCI image-layout directory** 🔮 | plain dir per the OCI layout spec — inspectable with `skopeo`/`crane`, trivially backed up | **hosted default** (Decision #6) |
| ZenFS-on-disk 🔮 | ZenFS with a disk backend; identical code path to the browser | dev/test parity |
| In-memory ✅ | ZenFS `InMemory` | per-session sandboxes, CI |
| Real directories ✅ | `node:fs/promises` through the same `PodFs` interface | hostDir mounts, existing `ArtiMount` behavior |

## Execution backends

### just-bash isolate ✅

Same interpreter as the browser ([bash-isolate.md](bash-isolate.md)). Server sessions (from artipod-sync, moving to `@artipod/core/manager`): per-session pods with TTL eviction, `hardened` execution-limit profile, per-fs byte caps, in-flight guards, optional bearer auth. ZenFS + just-bash must be externalized from the Next/webpack server bundle (`serverComponentsExternalPackages`).

### Docker realizer ✅ (core), 🔮 (manifest-driven)

Real container execution for pods whose mounts are host directories:

- Image built from [container/Dockerfile](../container/Dockerfile) (Alpine, unprivileged `artipod` user), hash-tagged for reuse.
- Hardening (do not regress): `CapDrop: ALL`, `ReadonlyRootfs`, `no-new-privileges`, private IPC, `NetworkMode: none` by default, tmpfs `/tmp` + `/var/tmp` (noexec), memory/CPU/pids limits, optional seccomp allowlist ([container/seccomp-profiles/sandbox.json](../container/seccomp-profiles/sandbox.json)).
- Each mount binds at its manifest `path` (historically `/context/<name>` — now just our default template; mount placement is app-chosen, Decision #3).
- **Constraint:** Docker cannot bind a *virtual* (browser-synced) mount. The pattern is: sync the pod to the server (Phase 6), materialize on disk, then run the container job. A manifest with virtual sources fails fast on this realizer with an actionable error.

### Later: container2wasm via 9P 🔮

Issue #1 sketches exporting any pod subtree through 9P to a WASM Linux VM (`@artipod/oci-9p`, `@artipod/container2wasm`) — heavier, fuller compatibility; not scheduled.

## The server manager 🔮

A long-running manager process (initially inside the artipod-sync Next server, later a standalone daemon):

- hosts pods (sessions and durable pods) over its PodStore
- serves sync: anti-entropy blob/ref exchange, `/api/oci` registry proxy (allowlist injected at init, default deny-all)
- is an **authority**: issues leases, validates offline grants, holds/receives delegation certs, enforces signed admin policy ([security-model.md](security-model.md))
- can itself be delegated (ship/station/site managers) and can relay blind (ciphertext cache) for scopes it holds no keys for ([encryption.md](encryption.md#offline-use-cases))
- acts as a **site pull-through cache** (Phase 6.6): digest-keyed, verify-on-receipt, `Range`-capable; blind (ciphertext-only) for encrypted pods so PHI never sits plaintext on the cache box; an overnight job pre-pulls the schedule's pods so browsers hydrate over LAN ([browser.md](browser.md#lazy-hydration--phase-66))

## Deployment

Reference deployment (artipod-sync today): Next.js release build behind systemd —

```ini
# deploy/artipod-sync.service (artipod-sync repo)
ExecStart=…/node_modules/.bin/next start -p 3000
Restart=always
```

`npm ci && npm run build && sudo systemctl restart artipod-sync`. Environment: `EXEC_API_TOKEN` (optional bearer auth for `/api/exec`), `GIT_PROXY_ALLOWED_HOSTS`, and 🔮 `OCI_PROXY_ALLOWED_HOSTS` (empty = proxy disabled), KMS/key-authority configuration for the manager.

## Node facts

- Node ≥ 18 (`engines`); Node 20 LTS recommended. Pure ESM package.
- `dockerode` is confined to `@artipod/core/docker` — browser entries never import it.
- The full streaming `Sandbox` class of just-bash (incremental stdio over real dirs) is available on Node only; the browser is buffered-only ([bash-isolate.md](bash-isolate.md#the-buffered-io-constraint)).
