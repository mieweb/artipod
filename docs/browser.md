# Browser implementation

> **Status: mostly ✅** — storage, the pod graph, lazy hydration, and the UI surfaces ship in `@artipod/core` today (plan Phases 2–6.6), encrypted stores included. Ingest API and devices are 🔮 (Phase 7).

The browser is a first-class artipod runtime, not a viewer: full bash, git, agents, storage, and (by design) OCI versioning run in-page, offline.

## Storage ✅

ZenFS is the single filesystem; every consumer (shell, git, tools, editor, tree) sees one coherent graph.

| Backend | Notes |
|---|---|
| **IndexedDB** (default) | stable everywhere; store name `artipodfs` (legacy `browser-git-fs` auto-upgraded) |
| **OPFS** (opt-in) | `WebAccess` backend; markedly faster for many small files; async-only — never use sync fs APIs |
| **memory** | tests and server sessions |

- **Migration**: settings UI copies `/` → verify (file count + bytes) → flip pref → reload; progress callback.
- **Multi-tab**: advisory multi-writer — Web Locks coordinate (`isPrimaryTab`, per-workspace locks) and shared UI state is written race-safely, but per-tab ZenFS caches mean tabs don't see each other's live file writes. Full semantics, failure modes, and the coherence roadmap: [multi-tab.md](multi-tab.md).
- **Quota**: surface `navigator.storage.estimate()`; large OCI blobs prefer OPFS streaming when available 🔮.
- Model weights (local ONNX agents) live in OPFS `artipod-models/`, a **sibling** of the pod fs — invisible to agents and never inside any pod.

## The pod graph ✅ (Phases 3–5)

```
OCI blobs (ciphertext at rest when encryption is enabled)
  → OciLayerFS (one layer, ro) → OciViewFS (ordered layers, whiteouts)
    → ZenFS CopyOnWrite upper (the workspace)
      → IndexedDB / OPFS
```

Snapshots are references (manifest + upper generation), so agent-turn auto-checkpointing is cheap and captures *everything*, including shell side effects — unlike editor-level checkpoint systems that shadow-copy only tool-edited files.

## Lazy hydration ✅ (Phase 6.6)

**The OCI layer is the unit of hydration.** Pods materialize at `refs` · `index` · `full`. At `index`, the pull transfers only the manifest plus small published layer-index artifacts — the *complete* namespace lists and stats from the indexes, while every file in a lazy layer is a placeholder. Opening a file downloads its winning layer's whole blob (digest-verified, cached as one OPFS file), then serves from cache. Driving case: one pod per patient on today's schedule — notes/FHIR in eager layers, each DICOM study grouped into its own lazy layer at commit time (`artipod commit --layer-group 'dicom/**'`, annotation `org.artipod.hydration: lazy`).

- Plain OCI throughout: annotations + one small index artifact per layer — no seekable-tar/eStargz/SOCI machinery. If layer granularity ever proves too coarse, seekable formats slot in behind the same `LazyLayer` abstraction without changing the pod model.
- **Hydration is always explicit**: UI click (hydrate-then-open), `artipod hydrate|dehydrate <glob>` (operates on backing layers), or the agent `prefetch` tool. Reads of dehydrated content fail fast with a hydrate hint — `grep -r` can never trigger a bandwidth storm.
- Three bandwidth lanes: interactive (reserved headroom) ≻ prefetch (rules + AI hints, e.g. "orders mention chest CT → prefetch that study's layer") ≻ background sync. Interrupted downloads resume by byte offset.
- `dehydrate` evicts layer blobs under storage pressure but keeps indexes/placeholders; state in `/proc/hydration`, progress on `pod.events`.
- On a LAN with a [site cache manager](linux.md#the-server-manager-), blob fetches hit the local cache first and fall back to WAN.

## Ingest API ✅ first slice · 🔮 media (Phase 7)

Files and media enter the pod programmatically. Shipped today (`pod.ingest`, or `createIngest(zfs, events)` from `@artipod/core/sandbox` for a bare fs):

```ts
const { path, size, digest } = await pod.ingest.put('/media/scan.pdf', file, { mime: file.type }); // Blob | File | bytes | string

const w = pod.ingest.open('/inbox/visit-001.webm', { mime: 'video/webm' });                       // MediaRecorder timeslices
recorder.ondataavailable = (e) => void w.append(e.data);                                          // appends are serialized
recorder.onstop = async () => { const { digest } = await w.close(); };                            // seal → fs:changed
// w.abort() discards the partial file
```

Every chunk reaches the backend as it lands (a crashed tab keeps partial audio/video at its pod path; the file is readable-as-written), `close()` seals it and emits one precise `fs:changed` (`origin: 'ingest'`). `mime` is advisory — ZenFS has no xattrs — and is echoed back for adapters to record. Digests are SHA-256 of the sealed bytes (computed by re-reading on `close()`).

Still design: `recordMedia(mediaStream, path, { timesliceMs })` wrapping the MediaRecorder itself, WHATWG `createWriteStream`, and one `ObjectStream` machine (append → replicate → seal → OCI blob) with chunk logs spilling to OPFS under a bounded memory window and transfers resuming from the last acked offset. Note that saves future grief: `getUserMedia` yields a `MediaStream` (tracks, no bytes — no `.getReader()`); the consumer owns the MediaRecorder until `recordMedia` lands.

## Devices 🔮 (Phase 7)

A `/proc`-framework provider enumerates `mediaDevices.enumerateDevices()` into `/dev`:

```
/dev/audio0 … /dev/videoN     inputs (one node per physical device)
/dev/speaker0 …               audiooutput sinks (write = playback, setSinkId)
/dev/microphone → audio0      default symlinks; metadata in /proc/devices/
```

Re-enumerates on `devicechange`; labels are blank until the first `getUserMedia` grant (platform behavior). Bounded `record -d 10s /dev/video1 <dest>` may block its single exec; unbounded capture goes through host-side stream tasks (see [bash-isolate.md](bash-isolate.md#the-buffered-io-constraint)).

## UI surfaces ✅ → `/host`

Headless controllers in the package; thin `'use client'` shells in apps:

- `TerminalSession` — line discipline, history ↔ `BASH_HISTORY`, tab completion, Ctrl+C abort; xterm-shaped I/O contract
- `FileBuffer` — open/save/isDirty + external-change detection via `fs:changed`
- `TreeSource` — tree data + invalidation; roots from the pod manifest

Coherence rides `pod.events` (`exec:*`, `fs:changed`, `edit:request`, `agent:tool-call`, `snapshot:*`, `approval:request`) — command-boundary invalidation, deliberately not ZenFS `fs.watch`. The Ctrl+~ overlay ([console.md](console.md)) is a packaged consumer of exactly these controllers.

## Browser platform cautions

- Import only `just-bash/browser` (root entry drags Node-only modules); gzip via `DecompressionStream`/`fflate`, never just-bash's Node-only gzip.
- xterm/Monaco load behind `dynamic(…, { ssr: false })`; `@artipod/core` browser entries stay import-safe in Node for tests.
- Registry/network egress: git and OCI traffic go through the app's proxies with host allowlists (default deny for OCI); PATs and keys never live inside the pod fs where agents could read them.
