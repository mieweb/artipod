# Browser implementation

> **Status: mostly ✅** — everything in "Storage" through "UI surfaces" ships in artipod-sync today and moves into `@artipod/core` in plan Phase 2. Ingest API and devices are 🔮 (Phase 7); encrypted stores are 🔮 (Phases 4/6.5).

The browser is a first-class artipod runtime, not a viewer: full bash, git, agents, storage, and (by design) OCI versioning run in-page, offline.

## Storage ✅

ZenFS is the single filesystem; every consumer (shell, git, tools, editor, tree) sees one coherent graph.

| Backend | Notes |
|---|---|
| **IndexedDB** (default) | stable everywhere; store name `artipodfs` (legacy `browser-git-fs` auto-upgraded) |
| **OPFS** (opt-in) | `WebAccess` backend; markedly faster for many small files; async-only — never use sync fs APIs |
| **memory** | tests and server sessions |

- **Migration**: settings UI copies `/` → verify (file count + bytes) → flip pref → reload; progress callback.
- **Multi-tab**: Web Locks single-writer guard (`navigator.locks`); second tab runs read-only — UI honors `isPrimaryTab`, controllers accept `readOnly`.
- **Quota**: surface `navigator.storage.estimate()`; large OCI blobs prefer OPFS streaming when available 🔮.
- Model weights (local ONNX agents) live in OPFS `artipod-models/`, a **sibling** of the pod fs — invisible to agents and never inside any pod.

## The pod graph 🔮 (Phases 3–5)

```
OCI blobs (ciphertext at rest once 6.5 lands)
  → OciLayerFS (one layer, ro) → OciViewFS (ordered layers, whiteouts)
    → ZenFS CopyOnWrite upper (the workspace)
      → IndexedDB / OPFS
```

Snapshots are references (manifest + upper generation), so agent-turn auto-checkpointing is cheap and captures *everything*, including shell side effects — unlike editor-level checkpoint systems that shadow-copy only tool-edited files.

## Ingest API 🔮 (Phase 7)

Files and media enter the pod programmatically; everything funnels into one `ObjectStream` machine (append → replicate → seal → OCI blob):

```ts
await pod.put('/media/scan.pdf', file);                                   // File | Blob | bytes | ReadableStream
await resp.body.pipeTo(pod.createWriteStream('/media/big.bin'));          // any WHATWG stream
const rec = pod.recordMedia(mediaStream, '/inbox/visit-001.webm',
                            { timesliceMs: 500 });                        // wraps MediaRecorder
await rec.stop();                                                         // seal → digest → blob → snapshot
```

Notes that save future grief: `getUserMedia` yields a `MediaStream` (tracks, no bytes — no `.getReader()`); `recordMedia` hides the MediaRecorder wiring. While open, the file is readable-as-written at its pod path and `pod.events` reflects growth. Chunk logs spill to OPFS with a bounded memory window; transfers resume from the last acked offset.

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
