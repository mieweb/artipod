# Folder sync & convergence

> **Status**: publish / lazy open / fetch-on-read / bidirectional write-back / per-path merge (`mergeHeads`, D9 `mergers`, merge-on-push) ✅ (sync-demo-plan Phases C–F, shipped in this repo and live in [examples/artipod-sync](../examples/artipod-sync)). Editing rule: when implementation diverges from this doc, fix the doc in the same PR.

## The model

A folder on a server becomes an artipod (`publishDirectory`): **one layer per file** by default, each layer carrying a published index artifact plus the LWW clock — `org.artipod.mtime` and `org.artipod.actor` — and every manifest linking its predecessor through `org.artipod.parents`. A client opens that ref as a **lazy basis with a writable overlay** (`artipod open`): `find` lists everything from indexes with zero transfer, reading a file fetches exactly its layer (`hydration.onDemand: 'fetch'`), and writes land in a CoW upper. A debounced push turns the upper into appended per-file layers (deletes become whiteouts) on the same ref; the server materializes pushed heads back into the real folder (`materializeRef`), with mtimes round-tripped so re-publishing is a CAS no-op.

Formally (sync-demo-plan §3.6): blobs and manifests form a **G-Set** — content-addressed, so replication never conflicts. The only mutable state is a ref head, which advances by a deterministic **per-path last-writer-wins** merge keyed by `(mtime, actor)`. Losing layers are never destroyed: they stay reachable through the parents DAG.

```
server folder ── publishDirectory ──▶ per-file layers + indexes ──▶ ref head
     ▲                                                                │ index-level pull
     │ materializeRef (mtime round-trip)                              ▼
real files ◀── pushed heads ◀── overlay push (debounced) ◀── browser CoW upper
```

## What LWW means for your files

Concurrent edits to **different files** merge losslessly (union). Concurrent edits to the **same file** resolve wholesale: the newer `(mtime, actor)` bytes win everywhere, and the loser remains recoverable from history. That is the right default for opaque files — and the wrong join for files that are *themselves* CRDTs.

## Publishing a workspace (`publish`)

Everything above assumes a ref already exists. The `publish` gesture is how
local work *gets* a name — three cases, one command (shipped in the demo
workspace shell; the machinery is `pushOverlay` + a seeded head):

| workspace | command | what happens |
|---|---|---|
| blank (`/work/<id>`, no ref, no basis) | `publish me/thing:1` | a head is seeded from an **empty basis**, every file becomes a per-file overlay layer, the ref lands on the server; the workspace reopens under its new name (rw) |
| cow fork of `me/play:1` | `publish` (no arg) | **push back**: the fork's upper advances `me/play:1` itself via the same LWW path autoPush uses — the fork stops being a fork |
| cow fork of `me/play:1` | `publish me/mine:1` | **publish-as**: the new head is seeded from the *basis* head, so the new ref shares every basis layer (content-addressed — nothing re-uploads) plus the fork's upper as overlay layers; `me/play:1` never moves. The fork's upper is then emptied — the changes live under the new name, not in two places |

A blank workspace is deliberately *not* auto-pushed: sync is ref-addressed,
and an anonymous scratch dir has no name to push to (and every "New" click
mints a fresh id — auto-publishing would spam the catalog). Naming is the
act of publication.

Publish-as is also the designated exit from a [locked tag](serve.md#locked-tags):
the server refuses to move the locked head (403), but a cow fork plus
`publish <new-ref>` branches it under a name you own.

How these gestures compose into a full lifecycle — long-lived entities with
concurrent open workstreams that seal into immutable milestones (patients,
cases, customers, tickets) — is written up in [dossier.md](dossier.md).

## Composing with Yjs (YORM)

[mieweb/yorm](https://github.com/mieweb/yorm) keeps a canonical object in a `Y.Doc`, syncs it live over its own websocket runtime, and persists encoded Yjs state. Both layers are join-semilattices; they compose because they operate at different granularities with different tempos:

| | YORM / Yjs | artipod sync |
|---|---|---|
| Unit of merge | elements *inside* one `Y.Doc` | whole files (per-path LWW), blobs (G-Set) |
| Tempo | hot — every keystroke, live websocket | cold — debounced snapshots, offline transport, history DAG |
| Mutates doc bytes? | yes, semantically (CRDT transactions) | never — content-addressed, opaque |

**Store encoded snapshots in the pod** (`Y.encodeStateAsUpdate`), not unbounded update logs; artipod treats them as opaque bytes — the same rule as yorm's own design principle ("triggers emit intent, they do not rewrite CRDT state").

**When plain LWW is safe**: whenever the editing replicas are also connected through yorm's live channel. Every replica's snapshot is a *valid* Y.Doc state; if artipod's LWW picks the staler file for a head, nothing is lost — the live channel still converges every `Y.Doc`, and the next debounced push writes the fully-merged state. The pod copy is eventually the merged document.

**When you need the merger hook (D9)**: replicas that sync *only* through the artipod — offline rigs, air-gapped sites — concurrently editing the same `.ydoc` file. LWW would pick one whole encoded state even though Yjs can join them losslessly. Register a content merger:

```ts
// app code — @artipod/core stays yjs-free; the app injects the resolver
import * as Y from 'yjs';

mergeHeads(store, refA, refB, {
  mergers: { '**/*.ydoc': (a, b) => Y.mergeUpdates([a, b]) },
});
```

`Y.mergeUpdates` is deterministic, commutative, associative, and idempotent — exactly the resolver contract — so the digest-equality convergence guarantees hold; the merged bytes become a new layer with both parents recorded.

### Practical guidance

- **Keep the tempos separate**: yorm is the hot path (keystrokes, presence), artipod is the cold path (durable snapshots, offline transport, encryption, provenance). Artipod's ~2 s push debounce and yorm's `idle` projection trigger are the same philosophy.
- **Origin-tag round trips**: if materialized pod files are re-ingested into yorm (or vice versa), carry an origin marker — yorm's origin/causation IDs and artipod's `org.artipod.actor` annotation are the same loop-prevention idea.
- **CAS helps converged replicas**: replicas that saw the same updates usually encode byte-identical states, so duplicate pushes dedupe to no-ops. Treat that as an optimization, not a contract.
- **Security boundaries align**: a `Y.Doc` is a read-authorization boundary (yorm's rule: separate audiences → separate docs); an artipod adds encryption at rest and blind relays (docs/encryption.md) — an encrypted pod can carry documents its relay cannot read.
