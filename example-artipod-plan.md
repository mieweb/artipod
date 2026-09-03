# Example artipods plan — demo pods on ghcr.io, story told in layers

**Status**: Living implementation plan — the implementer updates this file as work proceeds (same rules as `artipod-layer-plan.md` §0)
**Date**: 2026-09-03
**Owner / Implementer**: horner (phase gates self-reviewed)
**Relates to**: `docs/dossier.md` (entity/workstream/milestone pattern — these pods are its worked examples made real), `spa-ui-plan.md` P11 (AgentPod), `docs/on-disk-layout.md`, `docs/serve.md`, and **templit's MDY spec** (`mieweb/templit/doc/mdy-specification.md` — the content format for every data-bearing artifact, §2.2).

## 1. Goal — the north star

> A public set of fictional-but-credible example artipods on **ghcr.io**, each built as a
> **sequence of layers over time** so that pulling successive tags (or walking the
> `org.artipod.parents` DAG) replays the story: a case opens, evolves, and closes; a chart
> accumulates encounters; a ticket gets triaged and resolved; an agent definition matures;
> an exposure-group belief is revised by evidence. The pods themselves are **built with
> artipod's own shell** (dogfood, §3.2), and consuming them has a simple→complex ladder:
>
> ```bash
> artipod run -it                    # blank pod; banner: “to see it in action, type: examples”
> artipod run -it example/case       # short-name alias, :latest
> artipod run -it example/patient
> artipod run -it example/case:intake                              # time travel
> artipod run -it ghcr.io/mieweb/artipod-examples/case:closed     # the full form the alias expands to
> ```
>
> The browser demo gets the same pods through its `/api/oci` relay (ghcr.io already
> allowlisted), and a help tutorial can prompt against them.

The point is not the files; it is that **the layer history IS the record**. Every demo
script should end with "now look at the manifest" moments: per-file layers, stage tags,
parents provenance, content-address dedup across stages.

## 2. The five examples

One coherent fictional universe so the pods cross-reference each other: **Acme Fabrication**
(a metal-fab plant), employee **Jordan Rivera** (welder, badge E-4471), occupational clinic
**Harborview Occupational Health**. All content fictional; every pod carries a
`DISCLAIMER.md` (synthetic data, no real persons/PHI).

Pod names are **one word** so the simple ref form reads like English (`example/case`);
the descriptive story lives in each pod's README, not its name.

| # | Pod (repo under `ghcr.io/mieweb/artipod-examples/`; simple ref `example/<name>`) | Angle | Story arc (= layer stages) |
|---|---|---|---|
| 1 | `case` | **Administrative** company recordkeeping: an employee absence case for an injury | intake/first report → visit 1 report received → visit 2 + modified duty → case closed / return to work |
| 2 | `patient` | **Clinical** medical record for the *same* patient — same events, different custodian, different detail | chart opened + intake encounter → encounter 2 (suture removal) → encounter 3 (work-status clearance) → chart current |
| 3 | `ticket` | An IT trouble ticket | opened → triage (diagnostics attached) → fix applied → verified & closed |
| 4 | `agent` | A pod whose artifacts ARE an agent (spa-ui-plan P11: `AGENT.md` with `needs:` capability names, `skills/`, `tools/`) | scaffold (AGENT.md + needs) → first skill → tool schemas → v1 sealed |
| 5 | `seg` | Industrial hygiene **Similar Exposure Group** (welders): Definition, Membership Rules, Exposure Profile, Evidence | definition + membership rules → initial (qualitative) exposure profile → sampling campaign evidence → profile revised with statistics |

Pods 1, 2, and 5 interlock: the case references chart encounters by ref+tag (never by
copying clinical content — that's the demo line between administrative and clinical
custody); Jordan is a member of the welders SEG, and the SEG's evidence layer postdates the
injury (a nice "why we resampled" beat). Pod 3 is deliberately standalone (different
audience). Pod 4 is the odd one out on purpose: it demos that "a pod of artifacts" covers
agents too.

### 2.1 Content design per pod

Folder discipline follows `docs/dossier.md` — shared summary files at the root (merged,
LWW), per-workstream folders that never collide.

**Content format is MDY** (templit `doc/mdy-specification.md`): every **data-bearing**
artifact is a `.mdy` — YAML front matter as the canonical structured data (FHIR-shaped for
the chart, eSheet-shaped for forms, generic YAML for ticket status and SEG statistics) with
a markdown narrative whose field links (`[198 lb](#vital-wt)`) bind spans to front-matter
ids. Narrative-only files stay plain `.md`. Why this matters here: (a) the pods double as
MDY/templit corpus (the spec's own sample is an occupational-health encounter — same
universe); (b) tutorial prompts can ask agents for the *typed* answer (front matter), not
just prose; (c) the U4 kerebron editor is the designated MDY-aware editing surface, so
these pods become its test fixtures for free; (d) zero executable content by construction.
Optional stretch (decide at X1): one shelf template (`templates/encounter-note.mdyt`) in
the patient pod to demo the template→document flatten.

**`case`** (entity = the case)
```
case.mdy                ← shared: status/employee/dates in front matter (updated every stage)
timeline.md             ← shared: append-per-stage event log
intake/
  first-report.mdy      ← first report of injury (OSHA-301-shaped front matter, fictional)
  witness-statement.md
visits/
  2026-01-14/report.mdy ← provider report received (admin copy: restrictions, next appt)
  2026-01-21/report.mdy
accommodations/
  modified-duty.mdy     ← stage 3
closure/
  return-to-work.mdy    ← stage 4
  case-summary.md
```
Stage tags: `intake` → `visit-1` → `visit-2` → `closed`; `latest` = `closed`.

**`patient`** (entity = the patient; the dossier doc's worked example, realized;
`.mdy` front matter is FHIR-shaped per the spec's clinical resolver)
```
summary.mdy  problems.mdy  allergies.mdy  medications.mdy  ← shared, merged
visits/
  2026-01-14/note.mdy  vitals.mdy  orders.mdy              ← per-encounter folders
  2026-01-21/note.mdy  procedure.mdy
  2026-02-04/note.mdy  work-status.mdy
```
Stage tags: `2026-01-14` → `2026-01-21` → `2026-02-04` (milestone-shaped, per the seal
grammar) plus rolling `chart` = latest. Tutorial beat: diff `example/case:visit-1` against
`example/patient:2026-01-14` — same event, two records, two levels of detail.

**`ticket`**
```
ticket.mdy              ← shared: status/severity/assignee in front matter (moves every stage)
updates.md              ← append-per-stage log
diagnostics/
  app.log  netstat.txt  env-report.md    ← stage 2 (real-looking log excerpts)
fix/
  change-record.mdy  rollback-plan.md    ← stage 3
resolution.mdy                           ← stage 4
```
Stage tags: `opened` → `triage` → `fix` → `closed`; `latest` = `closed`.

**`agent`** (shape per spa-ui-plan P11; content must not embed secrets or endpoints —
`needs:` names capabilities, the USER's environment grants them)
```
AGENT.md                ← instructions + `needs:` capability list (frontmatter)
skills/
  summarize-case/SKILL.md          ← stage 2 (works against pods 1/2 — the agent's demo
                                      skill is "summarize a dossier pod")
tools/
  read-pod.json  search-pod.json   ← stage 3: tool schemas (dialect note: ozwellai-api
                                      owns the capability schema — mark as illustrative)
CHANGELOG.md
```
Stage tags: `scaffold` → `skill-1` → `tools` → `1.0`; `latest` = `1.0`. Running it via
harness-core is out of scope here (U4 spike, owner-gated) — this pod ships as *content*
the tutorial can read and the U4 work can later execute. (`AGENT.md` already uses YAML
front matter for `needs:` — the same machine-layer convention as the `.mdy` files.)

**`seg`** (the four artifacts, verbatim from the ask)
```
seg-definition.mdy      ← why these workers can be treated together
membership-rules.mdy    ← rules for who belonged and when (job codes, shifts, date ranges)
exposure-profile.mdy    ← what we believe their exposure distribution was (agent: Mn, Cr(VI),
                           welding fume; front matter carries the distribution — revised at
                           stage 4 with GSD/95th-percentile stats)
evidence/
  2026-02/sampling-plan.md
  2026-02/results.mdy               ← stage 3: personal sampling results (fictional; front
                                       matter = the rows, narrative = the lab summary)
  2026-02/field-notes.md
  observations/2026-01-30-walkthrough.md
```
Stage tags: `defined` → `profile-v1` → `sampled-2026-02` → `profile-v2`; `latest` =
`profile-v2`. The demo beat: `exposure-profile.mdy` at `profile-v1` says *"qualitative,
judged moderate, sampling scheduled"*; at `profile-v2` the same file carries statistics and
cites `evidence/2026-02/` — belief revised by evidence, and the layer history proves which
came first.

## 3. Mechanics — how stages become layers

### 3.1 Source of truth: stage trees in git

```
examples/artipods/
  README.md                     ← what these are, how to rebuild/publish
  case/
    stages/01-intake/…          ← each stage dir is the FULL desired tree at that point
    stages/02-visit-1/…            (not a delta — the build computes the delta)
    stages/03-visit-2/…
    stages/04-closed/…
  patient/stages/…              ← same shape for all five
  ticket/stages/…
  agent/stages/…
  seg/stages/…
  build.sh                      ← §3.2 (drives `artipod run` — dogfood)
  publish.sh                    ← §3.3
```

Full-tree-per-stage (not deltas) keeps authoring reviewable in git and lets the build be a
pure function; CAS dedup means unchanged files cost nothing across stages, and per-file
layers mean the manifest diff between stage tags is exactly "what changed" — which is the
demo.

### 3.2 Build = artipod itself (dogfood — ratified over a bespoke build script)

**Decision**: the pods are built **inside the artipod shell**, not by a node script over
core APIs. The build IS the demo — a shell transcript anyone could replay by hand — and
every friction found is a core bug to fix (that's the point). `build.sh` pipes one scripted
session per pod into the REPL (piped stdin is supported; the close-race fix in `repl()`
already covers it):

```bash
# build.sh — per pod; --rm = nothing kept, the pushed refs are the output
artipod run --rm --store dist-store \
  -v "$PWD/case/stages:/stages:ro" <<'EOF'
cp -r /stages/01-intake/. /
touch -d 2026-01-12T09:30 intake/first-report.mdy …   # story dates → org.artipod.mtime
commit --tag ghcr.io/mieweb/artipod-examples/case:intake
push ghcr.io/mieweb/artipod-examples/case:intake
cp -r /stages/02-visit-1/. /
commit --tag ghcr.io/mieweb/artipod-examples/case:visit-1
push ghcr.io/mieweb/artipod-examples/case:visit-1
…
EOF
```

Why this composes today: `-v …:ro` mounts are tool-layer only and **excluded from snapshot
roots** (the stage source never leaks into a commit); `commit --tag` freezes the live tree;
`push` moves it to `sync.remote`; successive commits in one session chain the parents DAG —
the timeline is *actual shell history*. Refs are committed under the full ghcr name so the
dist-store needs no retagging at publish (the `example/` alias, §3.5, makes the short form
equivalent everywhere else).

**Dogfood gaps to verify at X2 — and FIX in core when they bite** (each becomes a commit,
not a workaround in build.sh):

| # | Suspected gap | Fix if real |
|---|---|---|
| G1 | CLI `run` may not wire `--store` as `sync.remote` (push target) | wire it — `push` from a CLI pod should land in the layout store |
| G2 | `commit` may not chain `org.artipod.parents` across successive commits | annotate parents; the DAG is the whole demo |
| G3 | sandbox `touch` may lack `-d`/timestamp setting | add it (needed for narratively-correct dates + deterministic digests) |
| G4 | `commit` layer granularity/dedup vs `publishDirectory`'s per-file CAS layers | ensure unchanged files re-use blobs across stages (the “what changed” manifest diff is the demo) |
| G5 | volume-flavored config on committed refs (so `materializeRef` lands them at `/`) | flag or default for `commit` in a CLI pod |

**Determinism**: pin every file's mtime to its in-story date via `touch -d` inside the
shell (G3). Same trees + same dates ⇒ same digests ⇒ idempotent re-publish and stable
tutorial-pinned digests — and `ls -l` inside a pulled pod reads like the story.

### 3.3 Publishing to ghcr.io

Core has no push-to-registry transport (pushes target a `PodStore`; serve is our registry)
— and it does not need one for this. The dist store is a spec-compliant OCI layout and its
refs already carry full ghcr names (§3.2), so `publish.sh` is a loop:

```bash
skopeo copy --all --preserve-digests "oci:dist-store:$ref" "docker://$ref"
# or crane push; no retag mapping needed
```

Hard requirements on the pusher:
- **Digest preservation** (`--preserve-digests` / crane's default): parents annotations
  reference manifests by digest; a normalizing copy would orphan the DAG.
- Push **every stage tag** plus `latest`; verify each tag's digest on ghcr matches the
  local table.
- Repos set to **public** with anonymous pull (org setting; ask-first, §5).

ghcr accepts arbitrary artifact config mediaTypes (`application/vnd.artipod.volume.v1+json`)
— verified in the wild by the OCI artifact ecosystem, but X3 verifies with one pod before
pushing all five.

Automation: start manual (`publish.sh` beside `build.sh`, run by owner with a PAT/gh
login). A GH Actions workflow (rebuild + push on change under `examples/artipods/`) is a
follow-up decision once digests are proven stable — premature automation with unstable
digests would move tags on every CI run, which is exactly the anti-story.

### 3.4 Consumption paths (what the tutorial exercises)

| Surface | Command / action | Notes |
|---|---|---|
| CLI, simple | `artipod run -it example/case` | short-name alias (§3.5), `:latest` |
| CLI, discover | `artipod run -it` → banner → type `examples` | §3.5 |
| CLI, full form | `artipod run -it ghcr.io/mieweb/artipod-examples/case:closed` | works today: store-miss → `DirectRegistryTransport`; ghcr anonymous token dance is the same flow verified against docker.io |
| CLI time-travel | `run -it example/case:intake`, then `:visit-1`, … | each tag a fresh pod; `diff`/`find -newer` between them |
| Browser demo | open by ref via the `/api/oci` relay | hosted allowlist already includes ghcr.io; alias works there too (it lives in `parseImageRef`) |
| Inspection | `crane manifest`, `skopeo inspect`, or the pod's own `/proc`/shell | show per-file layers + parents annotations |
| Agent | tutorial prompts (§4) | |

### 3.5 Ref sugar — `example/<name>` and the `examples` verb (new core work)

Today `parseImageRef('example/case')` defaults the host to docker.io — so the simple form
needs a deliberate mechanism, not an accident. Two small core features (phase XC):

1. **Short-name alias table** in `parseImageRef` (`src/oci/transport.ts`), podman
   `registries.conf`-shortnames precedent: a built-in map
   `{ 'example/': 'ghcr.io/mieweb/artipod-examples/' }` applied before host detection.
   One table, every surface inherits it — CLI `run`, in-shell `pull`/`open`/`image`,
   browser transports, even `publish.sh`. Tags/digests pass through
   (`example/case:intake`, `example/case@sha256:…`). Deliberately NOT user-extensible yet
   (no config file); one hardcoded entry, documented in `--help` and `docs/examples.md`.
   Known tradeoff (ask-first): shadows a hypothetical `docker.io/example/*` — acceptable
   for a reserved demo prefix.
2. **`examples` shell verb + banner hint**: the blank-pod banner (`bannerNote`) gains
   *“to see it in action, type: examples”*; the verb prints a static five-row table —
   name, one-liner, stages, and the exact commands (`artipod run -it example/case`, or
   in-shell `open example/case`). No network on print; fetching happens when the user
   runs/opens. Keep it a table, not a wizard.

Simplicity ladder this buys: blank run → `examples` → `run -it example/case` → stage tags
→ full ghcr form (shown by `examples` as “what the alias expands to”) → crane/skopeo
inspection. Each rung is one concept longer than the last.

## 4. Tutorial integration (X4)

- `docs/examples.md` — one page: the universe, the five pods, a tag table, one runnable
  command per pod, and a "read the layers" section (crane one-liners).
- Help-tutorial prompt seeds (final copy at X4; one per pod, each exercising a different
  capability — note several lean on MDY front matter being machine-readable):
  1. *"Open `example/case:closed` and summarize the case timeline from `timeline.md`."*
  2. *"Compare `example/case:visit-1` with `example/patient:2026-01-14` — what does the
     clinical record know that the administrative case doesn't? Use the front matter,
     not the prose."*
  3. *"In `example/ticket:triage`, read `diagnostics/app.log` and propose a root cause;
     then pull `:closed` and check yourself against `resolution.mdy`."*
  4. *"Read `example/agent:1.0`'s AGENT.md — what capabilities does it need and what
     would grant them?"*
  5. *"In `example/seg`, show how `exposure-profile.mdy`'s front-matter distribution
     changed between `profile-v1` and `profile-v2`, and which files in `evidence/`
     justify the change."*
- Demo catalog: suggested-refs affordance so the SPA catalog can offer these for one-click
  open (scope decided at X4 — may be as small as README copy, may be a catalog list; do
  not build UI speculatively).

## 5. Ask-first list (owner sign-off required)

- Final ghcr namespace: **`ghcr.io/mieweb/artipod-examples/<name>`** proposed (multi-segment
  repos are fine on ghcr). Alternative: `ghcr.io/mieweb/examples/…`.
- Reserving the **`example/` short-name prefix** in `parseImageRef` (§3.5) — it shadows
  `docker.io/example/*` by design; and hardcoding the `examples` verb's table in core.
- Making the packages public / org package settings; whose credentials run the first push.
- Any GH Actions publish workflow (touches org secrets/OIDC).
- Fictional-universe naming if it should align with other mieweb demo material.
- AgentPod `needs:`/tool-schema dialect wording (ozwellai-api owns the schema — the pod
  must be labeled illustrative until that lands).
- `.mdy` extension in shipped example content (first artipod surface to adopt the templit
  MDY draft; the spec is still marked Draft).

## 6. Phase tracker (keep current)

| Phase | Scope | Status |
|---|---|---|
| X0 | Ratify §5 decisions; scaffold `examples/artipods/` + README + DISCLAIMER template | todo |
| X1 | Author all five pods' stage trees in MDY (content complete, front matter parses, cross-references resolve; `.mdyt` stretch decision) | todo |
| XC | Core dogfood affordances: `example/` alias in `parseImageRef` + `examples` verb + banner hint (§3.5); fix whichever of G1–G5 (§3.2) are real — each with tests | todo |
| X2 | `build.sh` dogfood sessions → dist-store; verify locally (`artipod run -it example/case --store dist-store`, layer/parents inspection, deterministic-digest rebuild, digest table into worklog) | todo |
| X3 | First ghcr push (one pod, verify anon pull + digest match + `artipod run -it example/case` from clean machine) → push remaining four | todo |
| X4 | `docs/examples.md`, tutorial prompts, catalog affordance decision, README pointers | todo |

Gates: every phase ends with the repo pre-commit gate (`npm run lint && npm run build &&
npm run test`); X2+ additionally paste the verification commands + digest table into the
worklog below.

## 7. Worklog

- 2026-09-03 — plan drafted.
- 2026-09-03 — owner amendments folded in: (1) content format = **MDY** per
  `mieweb/templit/doc/mdy-specification.md` (front matter = canonical data, linked
  narrative, no executable content; the spec's own sample is an occ-health encounter);
  (2) build **dogfooded through the artipod shell** (`build.sh` piped REPL sessions,
  `commit --tag`/`push`; gap table G1–G5, fix-in-core rule); (3) simplicity ladder:
  one-word pod names, `example/` short-name alias in `parseImageRef`, `examples` shell
  verb + blank-pod banner hint; full ghcr ref remains the taught "complex" form. New
  phase XC for the core work.
