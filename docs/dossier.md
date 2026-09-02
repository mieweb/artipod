# The dossier pattern — entities, workstreams, milestones

> **Status: shipped ✅ with demo affordances pending 🔮.** Everything here
> composes from mechanisms that exist today — per-path LWW merge
> ([sync.md](sync.md)), the parents DAG, publish/publish-as, the `isLocked`
> hook behind [locked tags](serve.md#locked-tags), `--seal-pattern`, and
> unsealed-tag delete. Editing rule: when implementation diverges from this
> doc, fix the doc in the same PR.

Many domains share one shape: a **long-lived entity** accumulates work through
**concurrent open workstreams** that eventually **seal into immutable
milestones**. A patient accumulates visits; a legal case accumulates filings; a
customer accumulates engagements; a support ticket accumulates incidents and
escalations. This doc maps that shape onto artipod's naming and merge
machinery — the medical record is the worked example, but nothing here is
medical.

## The mapping

| concept | artipod construct | example |
|---|---|---|
| entity (the dossier) | **repository** | `patients/123`, `cases/2026-cv-0042`, `customers/acme`, `tickets/9871` |
| open workstream | **mutable sigil tag** `_…` | `patients/123:_2026-08-01`, `customers/acme:_renewal-2027` |
| sealed milestone | **immutable tag** (shape ⇒ born locked) | `patients/123:2026-08-01`, `cases/…:filing-2026-09-02` |
| workstream isolation | **a folder per workstream** in the tree | `/visits/2026-08-01.enc-8f3a/…`, `/engagements/renewal-2027/…` |
| any historical state | **digest** `@sha256:…` | audit trail between milestones |
| provenance | `org.artipod.parents` DAG | "this engagement was based on that draft" |

## Tag grammar as policy

OCI tags allow `[a-zA-Z0-9_][a-zA-Z0-9._-]*` — no `~`, but a **leading `_` is
legal** everywhere (docker, crane, skopeo included). That gives a two-rule
convention the server can enforce mechanically via `isLocked`:

- `^_` → **open**: mutable, collaborative (rw + merge-on-push), deletable.
- milestone shape (e.g. `^\d{4}-\d{2}-\d{2}` for dates, or a domain's own
  pattern like `^filing-`) → **sealed**: create-once. The tag PUT that creates
  it succeeds; every later move is `403`. Implementable today as a closure
  over the store:

```ts
isLocked: async (ref) => {
  const tag = ref.slice(ref.lastIndexOf(':') + 1);
  return SEAL_PATTERN.test(tag) && !!(await store.getRef(ref)); // create-once
}
```

**Sealing is removing the sigil**: retag the workstream's digest without the
`_` (free — content-addressed; the new tag is born locked), then delete the
sigil tag. The invariant is worth saying out loud: *sealed tags can neither
move nor vanish; open tags can do both.*

Registries have partial precedent — Harbor's pattern-based tag immutability,
ECR's immutable-with-exclusions — but both are admin config bolted onto
mutable-by-default tags, applied per repo. Here immutability is **grammar**:
the name itself declares the lifecycle state, so a workflow cannot forget to
lock, and any client can tell open from sealed without asking the server.

## Folders as the concurrency policy

Merge-on-push joins heads **per path**, so workstreams that write under their
own folder are collision-free *by construction* — two open encounters, or an
engagement and a support escalation, fold into the entity in any order as a
pure union. Files deliberately shared across workstreams (`/problems.md`, a
customer's `/contacts.md`, a ticket's `/status.md`) are exactly where LWW plus
the history DAG (or a [content merger](sync.md#composing-with-yjs-yorm))
should arbitrate. Layout *is* policy:

```
patients/123                          customers/acme
├── summary.md      ← shared: merged  ├── profile.md        ← shared
├── problems.md     ← shared: merged  ├── contacts.md       ← shared
└── visits/                           └── engagements/
    ├── 2026-08-01.enc-8f3a/  ← per-workstream: union, never collides
    └── 2026-09-02.enc-91c2/          ├── renewal-2027/
                                      └── sev1-outage-0831/
```

## The lifecycle, concretely (medical example)

1. **Open**: Dr. A starts an encounter → `patients/123:_2026-08-01`, seeded
   from the last sealed milestone. Writes go under
   `/visits/2026-08-01.enc-8f3a/`.
2. **Concurrent open**: two weeks later, encounter still unsigned, Dr. B opens
   `patients/123:_2026-09-02` — seeded from either the last **sealed** visit
   (ignore the pending draft) or from `_2026-08-01`'s head (overlay on it; the
   parents DAG records that basis). Folder isolation makes either safe.
3. **Close in any order**: sealing strips the sigil —
   `_2026-08-01` → `2026-08-01` (born locked) — and the head merges into the
   rolling `:chart` tag. B closing before A is fine: different folders union;
   shared files resolve per-path LWW **by edit time, not close time** (a
   slow-closing draft does not overwrite newer work; losers stay reachable).
4. **Amend after sealing**: never move the sealed tag — publish
   `2026-08-01.amended-1`, whose parents point at the original. The record
   shows both, in order, forever.

The same script reads naturally with *case/filing*, *customer/engagement*,
*ticket/incident* substituted — only `SEAL_PATTERN`, the rolling-tag name
(`:chart`, `:docket`, `:account`, `:timeline`), and the folder prefix change.

## Late-binding identity — the unknown patient

Sometimes the workstream starts before the entity is known: a patient arrives
unconscious and without ID, an ambulance crew charts a run with no history, a
support incident opens before anyone knows which customer it belongs to. The
pattern doesn't break — the workstream just begins in a **provisional
repository** and folds into the real dossier later. Every step is machinery
that already ships:

1. **Open provisionally.** Publish from a blank workspace to a name that
   declares the uncertainty: `unidentified/2026-09-02-trauma-1:_intake`, or
   the rig's own namespace, `rigs/medic-7:_run-0902-3`. Naming is the act of
   publication ([sync.md](sync.md#publishing-a-workspace-publish)) — no basis,
   no prior history required, and an offline rig can chart against its local
   store and push when connectivity returns (sync is the cold path by
   design).
2. **Keep the folder discipline anyway.** Writes go under
   `/visits/2026-09-02.trauma-1/…` from the first note. The eventual merge
   into any dossier is then a pure union by construction — the provisional
   pod is shaped like a dossier fragment from birth.
3. **Identify, then merge.** Once the patient is `patients/123`, join the
   provisional head into the dossier — `mergeHeads(store, provisionalRef,
   patientRef, …)`, the same per-path join merge-on-push uses. Content is
   content-addressed, so nothing re-uploads; the merged manifest's
   `org.artipod.parents` records *both* heads, so provenance shows exactly
   what was collected under the provisional name and when it folded in.
   Shared files touched blind (an allergy noted in `/problems.md`) resolve
   per-path LWW **by edit time** — or via a registered
   [content merger](sync.md#composing-with-yjs-yorm) for structured files —
   and losers stay reachable either way.
4. **Retire the provisional name.** Its tags carry the `_` sigil, so they
   delete cleanly once merged; blobs and the DAG stay. The identification
   itself can be sealed as a milestone in the real dossier.
5. **Wrong patient?** Nothing was destroyed. The provisional head is still in
   the DAG: merge it into the *right* dossier, and correct the wrong one with
   the amend-after-sealing pattern — the record shows both, in order,
   forever.

Note the symmetry with the tag grammar: just as `_` declares *open* in the
tag, the namespace (`unidentified/`, `rigs/`) declares *unanchored* in the
repository name. Identity resolution is a merge, not a rename — so it can
happen days later, be wrong, and be corrected, without ever rewriting
history.

## What core provides

1. **Seal patterns ✅** — `artipod serve --seal-pattern '^\d{4}-\d{2}-\d{2}'`
   (env `ARTIPOD_SEAL_PATTERN`), or any embedder policy via
   `createArtipodApp({ isLocked })` as above. Composes with the explicit
   `--lock` list.
2. **Unsealed-tag delete ✅** — `DELETE /v2/<name>/manifests/<tag>` (202) and
   `DELETE /api/pods/refs?name=<ref>` (204), refused with 403 for sealed
   tags, so closing a workstream retires its sigil tag. Pointer removal
   only: blobs stay, and the DAG keeps the history.
3. Demo affordances 🔮 — entity rows grouping sealed milestones + open
   workstreams; "new workstream from: last sealed ▾ / pending draft".

Everything else — seeding from any head, publish/publish-as, merge-on-push,
create-once enforcement, digest audit trail — ships today.
