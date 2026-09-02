# Multi-tab concurrency in the browser

> **Status**: shipped behavior ✅ (advisory locks, shared cow uppers, race-safe UI state) with the coherence roadmap 🔮 at the end. Editing rule: when implementation diverges from this doc, fix the doc in the same PR.

Two browser tabs on the same origin share one storage bucket (OPFS or IndexedDB) but **not** one filesystem: each tab boots its own ZenFS instance with its own in-memory metadata and content caches. Everything in this doc follows from that split.

## What is shared vs per-tab

| Layer | Scope | Consequence |
|---|---|---|
| OPFS / IndexedDB bytes | shared per origin | writes from any tab land in the same place |
| ZenFS instance (caches, mounts) | per tab | a tab does not *see* another tab's writes until it reloads |
| Web Locks (`navigator.locks`) | shared per origin | cross-tab coordination works even though the fs view doesn't |
| In-memory overlay uppers (no `upperConfig`) | per tab | evaporate on close; two tabs never collide |
| Persistent cow uppers (`.artipod/uppers/<ref>`) | shared — keyed by **ref**, not tab | two tabs on the same ref write into the *same* upper |

So: two tabs opening the same pod in cow mode do **not** get divergent forks. They share one physical upper and diverge only in their cached view of it. The failure mode is not "two uppers" — it is **one upper, two incoherent caches**:

- **Same file edited in both tabs** → both flush to the same OPFS file; last flush wins, silently. The loser's bytes survive only if they were pushed (the parents DAG keeps losing layers reachable — see [sync.md](sync.md)).
- **Different files** → both persist fine, but each tab is blind to the other's file until reload (stale directory cache).
- **New blank workspaces** → each tab mints a fresh `/work/<id>`, so there is no collision by construction.

## What ships today

The demo treats tabs as **advisory multi-writer**: nothing blocks a second writer, but shared bookkeeping is made race-safe and the UI is honest about the rest.

1. **Web Lock coordination.** A shared advisory lock (`artipod-sync-fs`) tells a tab whether it is the primary; per-workspace locks (`artipod-ws-<id>`) keep the empty-workspace sweeper from reaping a directory another tab has open.
2. **Race-safe UI state.** The catalog/status file (`/.artipod/ui-state.json`) is read and written through **raw OPFS handles**, bypassing ZenFS caches entirely, serialized under a `'artipod-ui-state'` Web Lock, with `createWritable({ mode: 'exclusive' })` (Chromium 121+) as a hard backstop — a non-cooperating racer throws instead of silently clobbering. This is why two tabs can each create a pod without one vanishing from the other's status table.
3. **Honest labeling.** Pod *file contents* get none of the above: the UI banners that tabs do not share live changes, and the durable escape hatch is push/pull through the registry, not the shared cache.

### Why not just lock harder?

File-level locks cannot fix coherence: even perfectly serialized writes leave the other tab reading its stale ZenFS cache. Blocking the second writer (single-writer mode) was tried and rejected — it punishes the common case (two tabs on two *different* pods) to protect the rare one.

## The APIs, and why they only go so far

- **`createWritable({ mode: 'exclusive' })`** — main-thread safe, makes concurrent writers *fail loudly*. Used for `ui-state.json`. It does not make readers coherent, and ZenFS's `WebAccess` backend does not expose the option, so it cannot protect ordinary pod files today.
- **`createSyncAccessHandle()`** — a true exclusive lock plus fast synchronous I/O, but **workers-only**; it throws on the main thread, where ZenFS `WebAccess` runs. Unusable without a worker architecture.
- **Web Locks** — solve *ordering*, not *visibility*. They are the coordination substrate for everything above.

## Roadmap: two complementary fixes 🔮

**CRDT sync for open files.** If the editor is the writer, a `Y.Doc` per open file (keyed `<ref>:<path>`) synced over `BroadcastChannel` makes concurrent same-file edits *merge* instead of last-write-wins; the OPFS upper demotes to a persistence flush of the CRDT state, so the flush race becomes harmless — whoever flushes last writes the same merged bytes. This composes with artipod's per-path LWW exactly as described in [sync.md § Composing with Yjs](sync.md#composing-with-yjs-yorm): Yjs is the hot in-session path, artipod sync is the cold durable path. It does **not** cover shell/agent writes (`echo x > file`, git plumbing), directory operations, or binary files — those bypass the CRDT and keep LWW semantics.

**A SharedWorker-owned filesystem.** The structural fix: one SharedWorker owns the filesystem (free to use `createSyncAccessHandle` for speed and true exclusivity), tabs are thin clients over `MessagePort`. Single writer by construction, every tab reads coherent state, the multi-tab banner disappears — for *all* write paths, not just the editor. This is a significant ZenFS-integration project, not an option flip.

The likely end state is both: the SharedWorker for coherence and durability, Yjs for keystroke-granularity merge and presence in the editor pane.
