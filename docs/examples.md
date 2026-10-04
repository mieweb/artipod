# The example pods — `example/…`

> **Status: ✅ shipped** — seven fictional demo pods live at
> `ghcr.io/mieweb/artipod-examples/<name>`, each built as a sequence of layers
> over time so the **layer history is the record**. Content and build live in
> [mieweb/artipod-examples](https://github.com/mieweb/artipod-examples); the
> `example/` short-name alias, the in-shell `examples` verb, and `artipod tag`
> ship in core.

```bash
artipod run -it                     # blank pod — the banner says: type `examples`
artipod run -it example/case        # the alias expands to ghcr.io/mieweb/artipod-examples/case:latest
artipod run -it example/case:intake # time travel: every stage is a tag
artipod run -it ghcr.io/mieweb/artipod-examples/case:closed   # the full form
```

## One universe, seven custodians

**Acme Fabrication** (a metal-fab plant), employee **Jordan Rivera** (welder,
badge E-4471), clinic **Harborview Occupational Health**, treating provider
**Dr. Sam Okafor, DO**. Everything is synthetic — each pod carries a
`DISCLAIMER.md`, and identifiers use reserved-for-fiction shapes (900-range
SSNs, 555 numbers, Luhn-invalid NPIs).

| pod | custody / story | stage tags |
|---|---|---|
| `example/case` | **administrative** — injury-absence case | `intake` → `visit-1` → `visit-2` → `closed` |
| `example/patient` | **clinical** — the same injury as the chart sees it (FHIR-shaped MDY) | `2026-01-14` → `2026-01-21` → `2026-02-04`, rolling `chart` |
| `example/ee` | **payroll/HR** — jobs, wages, lost time (the PII pod) | `hired` → `promoted` → `absence` → `current` |
| `example/provider` | **credentialing** — the trust chain behind chart signatures | `application` → `verified` → `privileged` → `recred-2026` |
| `example/seg` | **industrial hygiene** — similar exposure group: definition, membership rules, exposure profile, evidence | `defined` → `profile-v1` → `sampled-2026-02` → `profile-v2` |
| `example/ticket` | IT trouble ticket | `opened` → `triage` → `fix` → `closed` |
| `example/agent` | an AgentPod — artifacts that define an agent (`AGENT.md` + `needs:`, skills, tools) | `scaffold` → `skill-1` → `tools` → `1.0` |

Three of them share one incident and never share data: wages live only in
`ee`, diagnoses only in `patient`, and `case` bridges by reference — grep any
one pod for the other two's facts and you'll find names of pods, not copies.
`provider` is why the chart's signature counts; `seg`'s exposure *belief*
(`profile-v1`) demonstrably predates its *evidence* (`sampled-2026-02`).

## What to demo

- **Time travel**: `artipod run -it example/seg:profile-v1` vs `:profile-v2` —
  same `exposure-profile.mdy`, different epistemic standing, and the evidence
  folder appears in between.
- **The DAG is the timeline**: each stage manifest's `org.artipod.parents`
  points at the previous stage. `artipod image history example/case` inside a
  shell, or `crane manifest ghcr.io/mieweb/artipod-examples/case:closed`.
- **Progressive loading**: `example/patient` carries two ~3.4 MB x-rays.
  `artipod image pull example/patient --index && artipod files example/patient`
  lists every file without moving a blob; `cat` of a note is instant while the
  x-ray visibly hydrates; each binary has an `.mdy` sidecar so an agent can
  answer imaging questions without ever fetching the image.
- **Dedup you can see**: pushing `:closed` after `:latest` moves **zero**
  blobs — content addressing, live on ghcr.

## Prompts for a tutorial

1. *Open `example/case:closed` and summarize the case timeline from `timeline.md`.*
2. *Compare `example/case:visit-1` with `example/patient:2026-01-14` — what does
   the clinical record know that the administrative case doesn't? Use the front
   matter, not the prose.*
3. *In `example/ticket:triage`, read `diagnostics/app.log` and propose a root
   cause; then pull `:closed` and check yourself against `resolution.mdy`.*
4. *Read `example/agent:1.0`'s AGENT.md — what capabilities does it need and
   what would grant them?*
5. *In `example/seg`, show how `exposure-profile.mdy` changed between
   `profile-v1` and `profile-v2`, and which files in `evidence/` justify it.*
6. *Jordan's wage history is in `example/ee`; Jordan's diagnosis is in
   `example/patient`. Show that each fact lives in exactly one pod — who
   references whom, and what does the case actually hold?*
7. *The 2026-01-14 note is signed by Dr. Okafor. Use `example/provider` to
   establish whether that signature was backed by verified credentials and
   privileges on that date.*
8. *List `example/patient`'s files without fetching content, summarize the
   x-ray from its sidecar alone, then hydrate only `visits/2026-01-14/imaging/`
   and compare how many bytes moved.*

## The alias, precisely

`example/` is a **reserved short-name prefix** (podman-shortnames precedent)
expanded inside `parseImageRef` before host detection — so every surface (CLI
`run`, in-shell `pull`/`open`/`image`, browser transports) resolves
`example/<name>[:tag][@digest]` identically. It shadows `docker.io/example/*`
by design; `examples/…` and every other name are untouched. The table is not
user-extensible.

## Content format: MDY

Data-bearing files are [MDY](https://github.com/mieweb/templit/blob/main/doc/mdy-specification.md)
— YAML front matter is the canonical structured data (FHIR-shaped in the
chart, generic YAML elsewhere), the markdown body is a narrative whose links
(`[open](#status)`) bind spans to front-matter ids, and nothing is executable.
Ask an agent for the *typed* answer, not the prose.

## Rebuilding

See the [examples repo](https://github.com/mieweb/artipod-examples): stage
trees are additive overlays with in-story mtimes; `build.sh` drives the stock
CLI (`import` chains `org.artipod.parents` on a rolling `:latest`, `tag` pins
each stage) into a from-scratch OCI layout that two builds reproduce
digest-for-digest; `publish.mjs` copies it to ghcr digest-preserving.
