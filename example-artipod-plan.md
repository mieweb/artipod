# Example artipods plan — demo pods on ghcr.io, story told in layers

**Status**: Living implementation plan — the implementer updates this file as work proceeds (same rules as `artipod-layer-plan.md` §0)
**Date**: 2026-09-03
**Owner / Implementer**: horner (phase gates self-reviewed)
**Relates to**: `docs/dossier.md` (entity/workstream/milestone pattern — these pods are its worked examples made real), `spa-ui-plan.md` P11 (AgentPod), `docs/on-disk-layout.md`, `docs/serve.md`.

## 1. Goal — the north star

> A public set of fictional-but-credible example artipods on **ghcr.io**, each built as a
> **sequence of layers over time** so that pulling successive tags (or walking the
> `org.artipod.parents` DAG) replays the story: a case opens, evolves, and closes; a chart
> accumulates encounters; a ticket gets triaged and resolved; an agent definition matures;
> an exposure-group belief is revised by evidence. Anyone can
> `artipod run ghcr.io/mieweb/artipod-examples/<name>:<stage>` — or open one in the hosted
> browser demo (its `/api/oci` relay already allowlists ghcr.io) — and a help tutorial can
> prompt against them.

The point is not the files; it is that **the layer history IS the record**. Every demo
script should end with "now look at the manifest" moments: per-file layers, stage tags,
parents provenance, content-address dedup across stages.

## 2. The five examples

One coherent fictional universe so the pods cross-reference each other: **Acme Fabrication**
(a metal-fab plant), employee **Jordan Rivera** (welder, badge E-4471), occupational clinic
**Harborview Occupational Health**. All content fictional; every pod carries a
`DISCLAIMER.md` (synthetic data, no real persons/PHI).

| # | Pod (repo under `ghcr.io/mieweb/artipod-examples/`) | Angle | Story arc (= layer stages) |
|---|---|---|---|
| 1 | `case-absence` | **Administrative** company recordkeeping: an employee absence case for an injury | intake/first report → visit 1 report received → visit 2 + modified duty → case closed / return to work |
| 2 | `patient-chart` | **Clinical** medical record for the *same* patient — same events, different custodian, different detail | chart opened + intake encounter → encounter 2 (suture removal) → encounter 3 (work-status clearance) → chart current |
| 3 | `it-ticket` | An IT trouble ticket | opened → triage (diagnostics attached) → fix applied → verified & closed |
| 4 | `agentpod` | A pod whose artifacts ARE an agent (spa-ui-plan P11: `AGENT.md` with `needs:` capability names, `skills/`, `tools/`) | scaffold (AGENT.md + needs) → first skill → tool schemas → v1 sealed |
| 5 | `seg-welders` | Industrial hygiene **Similar Exposure Group**: Definition, Membership Rules, Exposure Profile, Evidence | definition + membership rules → initial (qualitative) exposure profile → sampling campaign evidence → profile revised with statistics |

Pods 1, 2, and 5 interlock: the case references chart encounters by ref+tag (never by
copying clinical content — that's the demo line between administrative and clinical
custody); Jordan is a member of the welders SEG, and the SEG's evidence layer postdates the
injury (a nice "why we resampled" beat). Pod 3 is deliberately standalone (different
audience). Pod 4 is the odd one out on purpose: it demos that "a pod of artifacts" covers
agents too.

### 2.1 Content design per pod

Folder discipline follows `docs/dossier.md` — shared summary files at the root (merged,
LWW), per-workstream folders that never collide.

**`case-absence`** (entity = the case)
```
case.md                 ← shared: status, employee, dates (updated every stage)
timeline.md             ← shared: append-per-stage event log
intake/
  first-report.md       ← first report of injury (OSHA-301-shaped, fictional)
  witness-statement.md
visits/
  2026-01-14/report.md  ← provider report received (admin copy: restrictions, next appt)
  2026-01-21/report.md
accommodations/
  modified-duty.md      ← stage 3
closure/
  return-to-work.md     ← stage 4
  case-summary.md
```
Stage tags: `intake` → `visit-1` → `visit-2` → `closed`; `latest` = `closed`.

**`patient-chart`** (entity = the patient; the dossier doc's worked example, realized)
```
summary.md  problems.md  allergies.md  medications.md      ← shared, merged
visits/
  2026-01-14/note.md  vitals.md  orders.md                 ← per-encounter folders
  2026-01-21/note.md  procedure.md
  2026-02-04/note.md  work-status.md
```
Stage tags: `2026-01-14` → `2026-01-21` → `2026-02-04` (milestone-shaped, per the seal
grammar) plus rolling `chart` = latest. Tutorial beat: diff `case-absence:visit-1` against
`patient-chart:2026-01-14` — same event, two records, two levels of detail.

**`it-ticket`**
```
ticket.md               ← shared: status/severity/assignee (moves every stage)
updates.md              ← append-per-stage log
diagnostics/
  app.log  netstat.txt  env-report.md    ← stage 2 (real-looking log excerpts)
fix/
  change-record.md  rollback-plan.md     ← stage 3
resolution.md                            ← stage 4
```
Stage tags: `opened` → `triage` → `fix` → `closed`; `latest` = `closed`.

**`agentpod`** (shape per spa-ui-plan P11; content must not embed secrets or endpoints —
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
the tutorial can read and the U4 work can later execute.

**`seg-welders`** (the four artifacts, verbatim from the ask)
```
seg-definition.md       ← why these workers can be treated together
membership-rules.md     ← rules for who belonged and when (job codes, shifts, date ranges)
exposure-profile.md     ← what we believe their exposure distribution was (agent: Mn, Cr(VI),
                           welding fume; revised at stage 4 with GSD/95th-percentile stats)
evidence/
  2026-02/sampling-plan.md
  2026-02/results.csv               ← stage 3: personal sampling results (fictional)
  2026-02/field-notes.md
  observations/2026-01-30-walkthrough.md
```
Stage tags: `defined` → `profile-v1` → `sampled-2026-02` → `profile-v2`; `latest` =
`profile-v2`. The demo beat: `exposure-profile.md` at `profile-v1` says *"qualitative,
judged moderate, sampling scheduled"*; at `profile-v2` the same file carries statistics and
cites `evidence/2026-02/` — belief revised by evidence, and the layer history proves which
came first.

## 3. Mechanics — how stages become layers

### 3.1 Source of truth: stage trees in git

```
examples/artipods/
  README.md                     ← what these are, how to rebuild/publish
  case-absence/
    stages/01-intake/…          ← each stage dir is the FULL desired tree at that point
    stages/02-visit-1/…            (not a delta — the build computes the delta)
    stages/03-visit-2/…
    stages/04-closed/…
  patient-chart/stages/…        ← same shape for all five
  it-ticket/stages/…
  agentpod/stages/…
  seg-welders/stages/…
  build.mjs                     ← §3.2
```

Full-tree-per-stage (not deltas) keeps authoring reviewable in git and lets the build be a
pure function; CAS dedup means unchanged files cost nothing across stages, and per-file
layers mean the manifest diff between stage tags is exactly "what changed" — which is the
demo.

### 3.2 Build script (`examples/artipods/build.mjs`)

Node script over core APIs (no new core code expected):

1. Open/creates a dedicated OCI layout store (`examples/artipods/dist-store/`, gitignored)
   via `OciLayoutPodStore` — same format `~/.artipod/store` uses, so it is directly
   `skopeo`/`crane`-pushable.
2. Stage 1: `publishDirectory(stageDir, ref)` — per-file layers, volume-flavored config
   (so `materializeRef` lands it at `/`).
3. Stage N>1: seed a pod from stage N−1's head, overlay stage N's tree, push with
   `pushOverlay(..., { permanent: true })` — **permanent is mandatory** (repo memory: layers
   minted with `org.artipod.overlay` get stripped by a later empty push) — and
   `putRef` the stage tag. Each stage manifest's `org.artipod.parents` then points at the
   previous stage: the DAG is the timeline.
4. Tag `latest` at the final head. Print a digest table per pod (goes into the worklog).
5. **Determinism knob (decide at X2)**: layer annotations carry `org.artipod.mtime`; if we
   want bit-identical rebuilds (same digests → idempotent re-publish, stable
   tutorial-pinned digests), the build must pin mtimes from a per-stage `STAGE.json` date
   rather than checkout times. Recommendation: yes, pin — each stage has a canonical
   in-story date anyway, and it makes the timestamps *narratively correct* in `ls -l`.

Open implementation question for X2 (verify, don't assume): whether
`publishDirectory`'s no-op-republish path and `pushOverlay` compose as described for the
seed→overlay flow, or whether repeated `publishDirectory` per stage with explicit parent
annotation is simpler. Either is fine as long as (a) per-file layers, (b) parents DAG links
stages, (c) volume-flavored config.

### 3.3 Publishing to ghcr.io

Core has no push-to-registry transport (pushes target a `PodStore`; serve is our registry)
— and it does not need one for this. The dist store is a spec-compliant OCI layout, so:

```bash
crane push examples/artipods/dist-store ghcr.io/mieweb/artipod-examples/<name>:<tag>
# or: skopeo copy --all --preserve-digests oci:dist-store:<ref> docker://ghcr.io/…
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

Automation: start manual (a `publish.sh` beside build.mjs, run by owner with a PAT/gh
login). A GH Actions workflow (rebuild + push on change under `examples/artipods/`) is a
follow-up decision once digests are proven stable — premature automation with unstable
digests would move tags on every CI run, which is exactly the anti-story.

### 3.4 Consumption paths (what the tutorial exercises)

| Surface | Command / action | Notes |
|---|---|---|
| CLI | `artipod run -it ghcr.io/mieweb/artipod-examples/case-absence:closed` | works today: store-miss → `DirectRegistryTransport`; ghcr anonymous token dance is the same flow verified against docker.io |
| CLI time-travel | `run …:intake`, then `…:visit-1`, … | each tag a fresh pod; `diff`/`find -newer` between them |
| Browser demo | open by ref via the `/api/oci` relay | hosted allowlist already includes ghcr.io |
| Inspection | `crane manifest`, `skopeo inspect`, or the pod's own `/proc`/shell | show per-file layers + parents annotations |
| Agent | tutorial prompts (§4) | |

## 4. Tutorial integration (X4)

- `docs/examples.md` — one page: the universe, the five pods, a tag table, one runnable
  command per pod, and a "read the layers" section (crane one-liners).
- Help-tutorial prompt seeds (final copy at X4; one per pod, each exercising a different
  capability):
  1. *"Pull `case-absence:closed` and summarize the case timeline from `timeline.md`."*
  2. *"Compare `case-absence:visit-1` with `patient-chart:2026-01-14` — what does the
     clinical record know that the administrative case doesn't?"*
  3. *"In `it-ticket:triage`, read `diagnostics/app.log` and propose a root cause; then
     pull `:closed` and check yourself against `resolution.md`."*
  4. *"Read `agentpod:1.0`'s AGENT.md — what capabilities does it need and what would
     grant them?"*
  5. *"In `seg-welders`, show how `exposure-profile.md` changed between `profile-v1` and
     `profile-v2`, and which files in `evidence/` justify the change."*
- Demo catalog: suggested-refs affordance so the SPA catalog can offer these for one-click
  open (scope decided at X4 — may be as small as README copy, may be a catalog list; do
  not build UI speculatively).

## 5. Ask-first list (owner sign-off required)

- Final ghcr namespace: **`ghcr.io/mieweb/artipod-examples/<name>`** proposed (multi-segment
  repos are fine on ghcr). Alternative: `ghcr.io/mieweb/examples/…`.
- Making the packages public / org package settings; whose credentials run the first push.
- Any GH Actions publish workflow (touches org secrets/OIDC).
- Fictional-universe naming if it should align with other mieweb demo material.
- AgentPod `needs:`/tool-schema dialect wording (ozwellai-api owns the schema — the pod
  must be labeled illustrative until that lands).

## 6. Phase tracker (keep current)

| Phase | Scope | Status |
|---|---|---|
| X0 | Ratify §5 decisions; scaffold `examples/artipods/` + README + DISCLAIMER template | todo |
| X1 | Author all five pods' stage trees (content complete, cross-references resolve) | todo |
| X2 | `build.mjs`: stage builds → dist-store; determinism decision; verify locally (`artipod run` from `--store dist-store`, layer/parents inspection, digest table into worklog) | todo |
| X3 | First ghcr push (one pod, verify anon pull + digest match + `artipod run` from clean machine) → push remaining four | todo |
| X4 | `docs/examples.md`, tutorial prompts, catalog affordance decision, README pointers | todo |

Gates: every phase ends with the repo pre-commit gate (`npm run lint && npm run build &&
npm run test`); X2+ additionally paste the verification commands + digest table into the
worklog below.

## 7. Worklog

- 2026-09-03 — plan drafted.
