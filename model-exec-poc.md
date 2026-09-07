# Artipod pod model and execution proof of concept

**Status:** Living implementation plan - owner-approved execution-admission direction (2026-09-05); browser runtime MVP committed on `main` as `0f3fcf6` (2026-09-06). M0 tasks 1-2 and 4-6 are earned; 3, 7-11 remain open (see the checklist and the 2026-09-06 reconciliation worklog). The implementer updates this file as work proceeds (see section 0).
**Date:** 2026-09-06
**Owner / Implementer:** horner (phase gates self-reviewed)
**Builds on:** [spa-ui-plan.md](spa-ui-plan.md), [artipod-layer-plan.md](artipod-layer-plan.md), and [artipod-serv-plan.md](artipod-serv-plan.md).

## 0. How to work this plan (read me first)

This file is the single source of truth for this POC's progress. Keep task checkboxes, the phase tracker, decisions, and worklogs current. If implementation and the plan disagree, update the plan alongside the code; never silently diverge.

The working rules follow section 0 of [artipod-layer-plan.md](artipod-layer-plan.md), as adopted by [spa-ui-plan.md](spa-ui-plan.md), except that all phases use the single existing branch, `main`. The setup, scope, and gates below supersede those older plans' per-phase branch/PR workflow.

Read order: section 1 (goal), the decision register below, sections 6 and 10 (runtime and security), then section 11 phase by phase. Before each phase, re-read the relevant design sections and its verification requirements in section 12.

**Initial scope: M0-M4, sequentially gated.** The owner-approved amendment replaces hostile-guest isolation as the primary POC boundary with verified execution admission. Outsider pods remain data until approved; local development requires explicit authorization. Same-origin admitted applications are trusted with the workspace's browser authority. Restricted third-party execution, simultaneous independent workspaces, executable plugins, a browser build toolchain, and promoting a modified workspace to the installed workbench remain out of scope. The amendment does not retroactively pass M0.

### Setup

- Work in this repository; extend `examples/artipod-spa`, not the retired demo. Read its `AGENTS.md` and the SPA plan before app changes.
- Use the Node/npm versions supported by the current package manifests and CI. Install dependencies using the repository's existing workflow; do not upgrade packages as incidental setup.
- Record the starting revision and worktree state. Preserve unrelated work. No sibling checkout, new external harness package, registry account, or model credential is assumed to be available.
- Before the first implementation edit, record the core and SPA baseline checks from section 12 in the M0 worklog. A failing baseline is a blocker to classify, not a reason to fix unrelated code silently.
- Browser verification uses a real local `artipod serve --encrypt` and the existing SPA dev/export pipeline. Record ports, origin arrangement, browser versions, and synthetic fixture locations. M0 must establish any extra origin requirements without changing the deployed site.
- Before M0, identify an existing signature/attestation implementation and provision test-only publisher/approver identities with a host-configured trust root; record the choice before use. Before M2, identify a pending-submission store, reviewer identity, approved test catalog, and clean browser environment. Before M3, obtain owner confirmation of the harness/provider integration and an approved model configuration. Secrets stay outside this plan, pod artifacts, logs, and model context.

### Working rules

1. **Order:** M0 -> M1 -> M2 -> M3 -> M4; within a phase, work top to bottom. Start the next phase after the prior phase's checks pass and its gate is recorded, unless the owner explicitly approves overlap. No merge prerequisite.
2. **Single branch:** keep all work on `main`. Do not create phase branches; phase PRs are not required. This workflow change does not itself authorize a commit or push.
3. **Commits:** small conventional commits, roughly one per checked task. Check a box in the same commit as the implementation and evidence that earn it.
4. **Phase gate:** when all tasks including *Done when* pass, record the evidence and update the tracker on the same branch. When committing is authorized, use `docs(plan): model-exec phase MN gate` (for example, `docs(plan): model-exec phase M0 gate`) and record its hash. No phase PR or merge is required.
5. **Verification:** never check *Done when* without executing its checks. Paste each command and a one-line result into the phase worklog. Record browser procedures and observations with the same specificity. Mocks do not count as live model/browser/transport evidence.
6. **Deviations:** small filename/signature adjustments go into the task and worklog alongside the code. Architectural changes, scope expansion, or relaxation of acceptance criteria require owner sign-off first; record the decision and affected sections before continuing.
7. **Blocked:** after a genuine attempt, record the blocker, evidence, and needed decision. Raise it rather than silently substituting a different deliverable or marking the phase complete.
8. **Documentation:** update affected README/docs alongside behavior changes. Keep proposed and shipped behavior distinguishable throughout, not just at M4.

### Ask-first list (owner sign-off required)

- Any deployed-site, production origin/CSP, authentication, registry allowlist, or hosting configuration change.
- npm release/publish, public artifact publication, new external service costs, or credentials. M2 uses an explicitly selected local/test destination unless broader publication is approved.
- Changes to the existing `PodManifest` public contract, durable storage layout, capability dialect, or core security boundary beyond the execution-admission amendment recorded here.
- External Ozwell/harness-core integration choices, a new harness dependency, or replacement of the planned provider architecture.
- Production signing/identity infrastructure, organization enrollment, approver delegation, trust-root changes, or automatic approval of publishers/layers. The POC uses explicit test identities and does not establish production trust.
- Additional production runtime providers, unrestricted host processes, execution of unapproved external code, executable plugins, simultaneous independent workspaces, or installed-workbench self-modification. Approved same-origin execution is now in scope; hostile-code isolation is deferred.
- Architectural changes to the M0-selected origin/projection design after its gate, or proceeding after M0 fails its security/asset requirements.

### Phase tracker (keep current)

All phases run on `main`.

| Phase | Status | Gate |
|---|---|---|
| M0 - admission and browser runtime | in progress; MVP committed `0f3fcf6`: catalog Run, signed/dev admission, worker projection, preview lifecycle, telemetry. Open: CasePod mount selection, D4 record + bypass audit, offline cache/revocation port, mapped Sources replay, full-gate run | pending |
| MA - apps layer, process namespaces, `ps`/`kill` | owner-requested 2026-09-06; implemented in PR #57 (`2f35fa7`, `ed56df7`, follow-up): `@artipod/core/apps`, `ProcessTable` + `/proc/<pid>`, `ps`/`kill`, sample at `examples/lifecycle-app`, runbook `docs/apps.md`; live-verified on 2784 | earned pending PR review; not an M0 gate |
| MB - inventory depth: `-v`/`-vv`, hydration, `--json`, `/proc` manifests, glossary | owner-approved 2026-09-06 ("lets do it"); runs inside PR #57 | pending |
| M1 - semantic discovery and composition | narrow catalog discovery/UI overlap authorized 2026-09-06 and shipped in `0f3fcf6` (SPAPod descriptor + Run); full phase depends on M0 | pending |
| M2 - submission, review, and approved distribution | not started; depends on M1 | pending |
| M3 - agent-driven edits | not started; depends on M2 and provider confirmation | pending |
| M4 - multiple apps and documentation | not started; depends on M3 | pending |

### Decision register

The execution-admission direction was approved by the owner on 2026-09-05. Implementation choices still marked open are not approved or shipped by implication. Record subsequent approvals and changes here with their worklog evidence.

| ID | Decision or constraint | State / decision point |
|---|---|---|
| D1 | Keep the existing SPA as the trusted workbench; only admitted code runs, and same-origin apps share its browser trust boundary | Owner-approved amendment, 2026-09-05; not hostile-code confinement |
| D2 | Add shallow semantic conventions above existing filesystem/mount APIs; no inheritance framework | Plan constraint |
| D3 | One authoritative `artipod.json`; host-owned resolved mounts and grants remain separate | Proposed format; finalize in M1 without breaking `PodManifest` |
| D4 | Verify admission before executable URL projection; same-origin execution is permitted for approved releases or explicitly authorized local development | Direction approved, 2026-09-05. Candidate implemented in `0f3fcf6`: root-scoped worker intercepts only `/_artipod/run/`, grants are memory-only owner-bound capabilities, iframe `allow-scripts allow-same-origin`, CSP defense in depth, static server denies the prefix. Final record and forged-message/fallback/startup audit still open (M0 task 7). Earlier opaque-iframe failure remains historical evidence. |
| D5 | Multiple installed applications, one active preview; second viewer proves independence | Plan constraint |
| D6 | Submit a coherent application-only candidate; review and sign approval of its final digest before approved distribution | Owner-approved amendment; snapshot/transport/review integration selected in M2 |
| D7 | Declarative AgentPod/skills, existing trusted filesystem tools, no embedded harness | Plan constraint; external integration specifics need owner confirmation before M3 |
| D8 | Plain HTML/CSS/ES modules for the POC; full reload is sufficient | Plan constraint; no browser Next/TypeScript build pipeline |
| D9 | Separate author/publisher attribution from execution approval; support human or organizational identities with privately auditable responsible actors | Owner-approved direction; signing format, identity mapping, and test trust roots selected in M0; production enrollment deferred |
| D10 | Layer attestations are reusable evidence, never automatic approval of a new composition | Owner-approved direction; final application digest, executable dependency closure, and declared capabilities must be approved |
| D11 | Local edits invalidate release approval for the modified revision; explicit workspace-scoped development authorization permits local execution only | Owner-approved direction; authorization is revocable and cannot approve distribution |
| D12 | M0 signing candidate: RFC 7515 flattened JWS through `jose` 6.2.12, ES256, externally signed OCI-digest statements; separate publisher and approval payload types | Selected 2026-09-05; implemented in `src/apps/admission.ts` (was `lib/m0`) and pinned in `0f3fcf6`. Statement types/schema renamed `artipod-apps-*+jws` / `artipod.apps/v1` in MA. Node-signed evidence verified in Chrome (core-js codecs). Standard JWS envelope, application-specific artifact/approval claims; not Notary/Notation or Sigstore interoperability. |
| D13 | Test-only independent human/organization publisher keys and reviewer key, pinned host public JWKs; release approval lifetime at most one hour and offline freshness at most five minutes | Implemented as test policy in `0f3fcf6` (`MAX_APPROVAL_MS`, signed status freshness). Offline cached-approval reuse and remembered revocation exist only in retired probe evidence; port to the integrated runtime is open (M0 task 8). Production trust roots unchanged. |
| D14 | Preview lifecycle: Stop is a cooperative, acknowledged in-place suspend (`artipod:runtime-lifecycle/v1`); Close revokes and tears down; Reload starts a fresh instance | Owner-selected 2026-09-06, shipped in `0f3fcf6`. Not a generic iframe freeze; unsupported/unresponsive apps are shown as such. Telemetry is app-reported, informational only. |
| D15 | The browser app runtime ships as the core subpath `@artipod/core/apps` (browser-safe, adapter-injected, imports only dependency-free core leaf modules such as `oci/digest` and `oci/tar`, never the `/oci` barrel), not an SPA-private `lib/m0` and not yet a separate package | Owner-selected 2026-09-06 after pros/cons review. Lift to `@artipod/apps` later if a second consumer appears; a lifted package would need core to expose those leaves as a light subpath. `jose` moves to core deps. The service worker ships as a dist asset consumers copy to their site root. Weighbridge `./apps` budget 30 KB gzip (measured 19.2 KB). |
| D16 | Processes are namespaced per supervisor ("turtles all the way down"): a pod session owns a `ProcessTable`; shells, running apps and background tasks are its processes; a process that launches things owns a child table. Visibility is downward only; lifecycle cascades down; pids are namespace-local, identity is a uuid | Owner-selected 2026-09-06. Browser tabs and the server are separate namespaces — no implicit merge; cross-namespace views are explicit future commands. Signals map per kind (`STOP/CONT` = cooperative suspend/resume, `TERM/KILL` = close); unsupported → `ENOTSUP`, never a fake state. `/proc/<pid>/*` mirrors Linux layout. |
| D17 | Glossary vs OCI/Docker: **image** = OCI image (manifest + config + layers), **ref** = repository:tag, **file layer** = an ordinary OCI layer that artipod's publish/import path emits per file (granularity, not a new type), **lazy** = a layer whose blob is not fetched (hydration state, never granularity), **parents** (`org.artipod.parents`) = the tag's history across manifests. A workspace/cow fork is the "container" (upper over a basis). | Owner-discussed 2026-09-06. Do not call file layers "lazy layers". Known inconsistencies to fix later: `artipod commit` emits one whole-tree layer without parents (Docker-style) while `import`/`publish` emit file layers; `artipod image history` shows the layer stack, not the parents chain — rename to `image layers` and give `history` the parents DAG. Docker overlay2 cannot run a >128-layer artipod image as a rootfs; artipod volume images are not meant to be. "pod" collides with Kubernetes harder than "layer" with Docker; noted, not renamed. **Command names must not shadow Unix tools the shell already has:** the sandbox ships real `mount`/`umount`/`lsblk`/`df`/`findmnt` for ZenFS backends (storage-command.ts); the inventory listing of local workspaces is therefore `volumes` (docker's word), not `lsblk`, and `mount --help` points at `artipod image mount` / `artipod open`. |

### Reference map

| You need | Where |
|---|---|
| Plan workflow and SPA constraints | [artipod-layer-plan.md](artipod-layer-plan.md), [spa-ui-plan.md](spa-ui-plan.md), [examples/artipod-spa/AGENTS.md](examples/artipod-spa/AGENTS.md) |
| Current concrete mount declarations | [src/manifest.ts](src/manifest.ts) |
| Existing shell runtime and trust split | [docs/bash-isolate.md](docs/bash-isolate.md) |
| Browser storage and server execution | [docs/browser.md](docs/browser.md), [docs/linux.md](docs/linux.md) |
| Grant, key, and threat-model constraints | [docs/security-model.md](docs/security-model.md), [docs/encryption.md](docs/encryption.md) |
| Current workspace lifecycle | [examples/artipod-spa/lib/services/pod-session.ts](examples/artipod-spa/lib/services/pod-session.ts) |
| Browser app runtime layer (descriptor, capture, admission, runtime, lifecycle, processes) | `src/apps/` → `@artipod/core/apps` (MA); consumer runbook [docs/apps.md](docs/apps.md) |
| Process table, `/proc/<pid>` provider, `ps`/`kill` | `src/proc/processes.ts`, `src/sandbox/process-command.ts` (MA) |
| Lifecycle sample app | `examples/lifecycle-app/` (MA; was `examples/artipod-spa/m0-preview`) |
| Current harness integration surface | [examples/artipod-spa/components/AgentPanel.tsx](examples/artipod-spa/components/AgentPanel.tsx) |
| Publish/serve mechanisms and existing UI-artifact proof | [docs/sync.md](docs/sync.md), [docs/serve.md](docs/serve.md), [src/server/serve.test.ts](src/server/serve.test.ts) |

## 1. Recommendation and objective

Proceed with a small proof of applications operating on semantic pods, using the completed Artipod SPA as their trusted workbench. Make verified execution admission plus normal OPFS-backed browser loading/debugging the first gate. Do not begin by replacing the workbench or building a general plugin framework.

> An Artipod is a portable, inspectable namespace with declared semantics. Pod types add conventions. Storage determines where its bytes live. Runtime determines how executable contents run. Mounts and capabilities allow Artipods to compose.

The valuable workflow is:

```text
local application + independently mounted subject data
                         |
          explicitly authorized local development
                         |
             human or agent edits and preview
                         |
            application-only immutable snapshot
                         |
                submit -> review -> approve -> distribute
                         |
            same application + different subject data
```

The POC must demonstrate this workflow without coupling pod semantics to OPFS, OCI, a particular runtime, or an inheritance hierarchy.

## 2. Keep the concepts separate

| Question | Answer | Examples |
|---|---|---|
| What is it? | Semantic kind and optional profiles | SPAPod, CasePod, AgentPod |
| Where are its bytes? | Storage provider | OPFS, local disk, memory, OCI-backed filesystem |
| How does it run? | Runtime provider, if needed | Browser iframe, shell interpreter, WASM, container process |
| May it run here? | Verified execution approval or explicit local-development authorization | Exact approved release digest, authorized development session |
| What does it request? | Declared capabilities and resolved mounts | Read a case, edit an application, invoke a model; not malicious-code confinement for same-origin apps |

Object storage and remote registries are possible storage/distribution integrations, not requirements for this POC. OCI is an existing snapshot and distribution mechanism, not the definition of an Artipod.

Conceptual taxonomy, not class inheritance:

```text
Artipod
  Application
    SPAPod
  Subject
    CasePod
  Agent
    AgentPod
  Extension
    SkillPod
    PluginPod
  Runtime
    ContainerPod
```

Later domain profiles may include `ChartPod`, with `PatientPod` and `EmployeePod` conventions. They are not implementation requirements here. Not all pods execute: CasePod holds subject data, SkillPod may contain only instructions, and AgentPod is instantiated by a harness.

## 3. Reuse existing mechanisms

Before introducing an interface, verify whether the existing mechanism can carry the requirement.

| Concern | Existing foundation | POC direction |
|---|---|---|
| Filesystem and mounts | `src/manifest.ts`, realizers, ZenFS, pod APIs | Reuse; add semantic discovery above them |
| Shell execution | `@artipod/core/sandbox`, just-bash | Reuse browser/server interpreter and controls |
| Server process execution | Docker/Podman execution support | Document and reuse; no second process framework |
| Snapshots and distribution | `@artipod/core/oci`, existing publish/pull paths | Reuse for application-only artifacts |
| Synchronization | Existing pod sync and event mechanisms | Reuse notifications; do not invent another sync protocol |
| Agent execution | `ToolCallingLoop`, filesystem tools, current agent panel | Load AgentPod artifacts into the existing harness path |
| Workspace UI | `examples/artipod-spa` services and zustand stores | Extend with discovery, launch, grants, and preview |
| Introspection | Existing manifest serialization and `/proc` providers | Extend without duplicate sources of truth |

The current agent panel uses fixed instructions; loading AgentPod instructions and skills is new work. The earlier Ozwell/harness-core integration was deferred. This POC must not claim that integration already exists or silently replace the planned provider architecture.

## 4. Minimal semantic descriptor

Use one authoritative, portable semantic descriptor at the pod root: `artipod.json`. This proposed format is distinct from the existing `PodManifest`, which describes concrete mount realization. Preserve that API and reconcile terminology explicitly in documentation.

```json
{
  "apiVersion": "artipod.io/v1",
  "kind": "SPAPod",
  "metadata": {
    "name": "case-viewer",
    "version": "0.1.0"
  },
  "spec": {
    "entrypoint": "/app/index.html",
    "mounts": [
      { "path": "/case", "profile": "CasePod", "mode": "ro" }
    ]
  }
}
```

The initial validator needs version, kind, name, and the fields required by the supported profiles. Optional `conformsTo` identifiers can express additional conventions without deep inheritance. Do not build a profile registry or general schema language.

Profile-specific fields:

- SPAPod: entrypoint and requested compatible mounts.
- CasePod: `spec.subject` with a synthetic subject type and ID.
- AgentPod: references to its instruction file and skills.
- SkillPod: an instruction entrypoint, conventionally `SKILL.md`.

The host resolves a request for `/case` to an actual pod and storage source. Requested access is not an authorization grant. A downloaded descriptor must not select arbitrary host directories or grant itself access.

Keep resolved runtime state separate from portable author intent. Current mutability, granted permissions, resolved mount identities, and the running snapshot digest come from the host. A self-declared version or provenance field is not verified identity.

Keep signatures and approvals as separate attestations over immutable content digests, not a self-authorizing `approved: true` field in `artipod.json`. Inspection should distinguish claimed author, verified signer, trusted publisher, reviewer approval, and local-development authorization. Changes to the descriptor, executable dependencies, or capability declarations change the approved subject.

Inspect through the physical descriptor and existing `/proc` conventions. A future `/.artipod/manifest.json` projection may alias the descriptor, but must not become an independently maintained copy. Document how mounts, grants, runtime support, provenance, and snapshot identity can be inspected; clearly distinguish implemented files from proposed projections. Existing `/.artipod` storage and settings paths remain unchanged.

## 5. Multiple applications and composition

A CasePod does not belong to its viewer. Multiple applications can understand the same profile, and one application can open different compatible CasePods.

```text
                 Artipod Workspace
               trusted host and broker
                         |
              +----------+-----------+
              |                      |
         Case Viewer             Timeline App
              |                      |
              +------ CasePod -------+
                         ^
                     AgentPod
```

For the first implementation, support multiple installed applications with one active preview. Add a second minimal viewer after the main workflow succeeds to prove that composition is not hardcoded to Case Viewer.

Do not promise concurrent independent workspaces yet. The current session service serializes lifecycle operations, and ZenFS/proc ownership requires deliberate handling before multiple live sessions can coexist safely.

Within a launched application, the logical namespace is:

```text
/
  app/       application-owned files
  case/      host-resolved, read-only CasePod data mount
```

The CasePod can retain its own root descriptor and `case/` data layout. The host exposes the selected data subtree at the application's `/case`; introspection identifies the source pod and profile. Agents must be able to inspect the CasePod descriptor as well as its data through their separately scoped environment.

The viewer must not know whether `/case` is backed by OPFS, disk, memory, or a materialized artifact. The filesystem API enforces its read-only contract and the harness grants agent writes separately. However, an admitted same-origin app may bypass those APIs using ambient browser authority; mounts are not a hostile-code security boundary in this execution mode.

## 6. Execution model

| Execution label | Browser | Server |
|---|---|---|
| `isolate` | Existing controlled shell interpreter; restricted SPA isolation deferred | Existing controlled shell interpreter; other isolated providers only when explicitly supported |
| `binary` | Constrained: a supported browser-compatible binary such as WASM, or explicit delegation | Supported process execution, currently through existing Docker/Podman facilities |
| Trusted SPA | New admission-gated HTML/CSS/modules provider; same-origin execution permitted | Browser client may be hosted by serve; this does not create a server JS isolate |

These are practical execution labels, not mutually exclusive technical categories. WASM is binary code executed by a controlled runtime. The provider must state its supported format and capabilities, rather than implying that every provider can execute every pod.

### Existing isolate

Artipod's current bash isolate is just-bash over the pod filesystem in browser and Node. It interprets shell commands with controlled access and execution limits. Trusted host-side custom commands are an explicit authority boundary. It is not a general-purpose security sandbox for arbitrary JavaScript or a native process environment.

### Browser application provider

```text
OPFS-backed Artipod filesystem
              |
    execution admission check
              |
     authorized URL projection
          |
      trusted application
              |
    HTML / CSS / modules / WASM
```

The new provider must preserve ordinary asset behavior sufficiently for relative imports, dynamic imports, CSS assets, and binary fetches. Test root-relative URLs and source-map resolution explicitly; document any unsupported behavior instead of claiming full browser compatibility.

Downloaded code is inert until the supported launcher verifies an execution approval or an explicit local-development authorization. Admission must precede navigation, module import, script evaluation, worker creation, WASM execution, or instantiation of pod-provided agent instructions/skills. Inspection must not render unapproved HTML as active content. Loading bytes for inspection is different from allowing their interpretation as executable content.

After admission, a same-origin iframe or ordinary application context is permitted. An iframe may organize rendering/lifecycle, but is not advertised as a security boundary. Service workers supply routing, not trust. CSP is defense in depth; do not promise network/credential isolation from admitted same-origin code.

M0 must prove execution uses the exact verified release bytes, including executable dependencies, rather than checking a digest and later reading a changed mutable tree. Project production releases from immutable verified views. Local development uses a separately authorized mutable workspace and never displays the original release's approval for modified code. No unpinned external scripts, imports, or executable content from mutable subject mounts in the approved-release proof.

Keep OPFS and projection access behind existing host services for maintainability, without claiming those interfaces confine same-origin code. Serving bytes on demand from the live pod is acceptable. Copying the application into a conventional server directory as the execution source does not satisfy the browser proof. A dedicated development origin/profile is recommended around sensitive environments, but is not an M0 isolation requirement.

### Server binary provider

The conceptual contract is: resolve approved mounts, establish cwd/environment, apply supported restrictions, run the process, and capture stdin/stdout/stderr/status. Reuse existing container execution and describe its actual controls. Do not add unrestricted host process execution just to complete the matrix.

### Browser binary limitations

A normal browser cannot directly run arbitrary ELF or native server executables. A request must resolve to a supported browser runtime, such as an explicitly supported WASM ABI, or to approved server delegation. Otherwise it fails with an unsupported-runtime result. WASM availability does not imply arbitrary WASI programs or native dependencies work.

The smallest new runtime contract should express launch, supported requirements, status, reload, and disposal for SPA execution. Reuse existing command execution contracts for shell/process requests; do not force every execution model into a new universal interface prematurely.

## 7. Keep the workspace trusted

Extend the completed SPA as a workbench with application discovery, execution admission, compatible subject selection, development authorization, preview lifecycle, and review submission. Follow its current services/store architecture and UI conventions. Server-side review is an extension of the existing serve surface in M2, not a parallel backend or unrelated UI rewrite.

Distinguish two later uses of SPAPod packaging:

1. **Package the workspace's built assets:** useful for distribution and rollback. Existing server support for an imported `artipod-ui:latest` artifact provides a foundation, but is not proof of browser-local execution.
2. **Run the workspace as an ordinary guest:** deferred. The workspace currently owns keys, storage, publishing, and agent configuration. Packaging it as a pod does not make those privileges safe to grant to downloaded code.

Eventually an agent can edit a fork of the workspace under development authorization. Promoting that fork to the installed workbench requires separate explicit approval, compatibility checks, a pinned artifact, and a recovery version outside the editable application. Same-origin app approval in this POC does not authorize replacing the workbench installation or its configured trust roots.

Editable source and runnable assets are different concerns. The POC uses plain HTML/CSS/ES modules without a build step. Editing the Next/TypeScript workspace requires a build pipeline; providing that pipeline in-browser is not part of this POC.

## 8. Proof artifacts

### CasePod

Use only synthetic case data: ID, title, status, priority, several timeline events, and several notes. Define the smallest valid structure and allowed status/priority values needed by the demo.

```text
case-pod/
  artipod.json
  case/
    subject.json
    status.json
    timeline.json
    notes/
```

### SPAPod

```text
case-viewer/
  artipod.json
  app/
    index.html
    main.js
    style.css
```

Show title, status, priority, timeline, and notes by reading the mounted CasePod. Include a small imported module and an asset so URL projection is exercised beyond a single inline page. Render subject text as data, not executable HTML.

Use existing filesystem events to refresh data and reload an explicitly authorized development preview after saved application edits. A full iframe reload is sufficient; hot-module replacement is not required. Outside a development session, changed executable contents require new release approval. Specify cancellation/disposal and denial of future launches/reads after authorization revocation; this cannot claw back data already read or guarantee termination of hostile same-origin code.

### AgentPod and skills

```text
case-agent/
  artipod.json
  AGENT.md
  skills/
    case-editor/
      artipod.json
      SKILL.md
    spa-editor/
      artipod.json
      SKILL.md
```

Load the agent definition into the existing harness path; do not embed the harness in the pod. Preserve the planned `AGENT.md` convention and align capability names with existing provider work instead of inventing a competing permission dialect.

The case skill teaches discovery, inspection, adding notes, changing status/priority, and appending timeline events while preserving valid data. The SPA skill teaches inspection and editing of application-owned HTML/JS/CSS, followed by preview reload. Both operate through scoped filesystem tools rather than bespoke case-edit or UI-edit APIs.

Skills are guidance, not security controls. Host-enforced path and operation grants apply regardless of model behavior. An agent-facing shell must not bypass those restrictions. Agent instructions, case content, and tool arguments cannot approve their own capabilities.

Admit AgentPod and SkillPod definitions before loading them into the harness, even though their instructions need not be executable JavaScript. Pin their composition and approval separately from the SPAPod. CasePod content remains untrusted data, not an instruction source allowed to escalate tools. An agent may edit an authorized development fork and submit a candidate, but receives no publisher/reviewer signing key or permission to approve its own output.

Model endpoint configuration and credentials remain host/user-owned and outside pod artifacts. Explain that using a remote model discloses the supplied context to that provider; filesystem grants alone are not consent to send subject data remotely.

Do not add downloaded executable agent tools or general PluginPod loading in this POC. Use the existing trusted tool implementations. Any unresolved external harness/provider integration must be identified before its phase starts, not represented by a scripted mock as completed integration.

## 9. Snapshot, publish, and clean installation

Use existing Artipod/OCI infrastructure:

```text
mutable application workspace
              |
    application-only snapshot
              |
 signed immutable candidate -> pending server review
      |
 reviewer approval of final composition digest
      |
   approved release distribution
              |
       clean environment install
              |
     host grants a different CasePod
              |
          run application
```

Snapshot application-owned files and descriptor only. Do not snapshot the composed runtime namespace indiscriminately. Mounted CasePod data, AgentPod state, host metadata, credentials, and resolved grants must not enter the application artifact.

Serialize or otherwise stabilize application writes during snapshot creation so the artifact contains a coherent saved revision. Reuse existing machinery where possible and document its actual consistency guarantees. Verify the installed digest, not merely a mutable tag.

The clean-environment proof must work without the original OPFS contents. Pull the artifact and approval evidence from an existing registry/serve transport, verify identity, policy, digest, and approval validity, mount another synthetic case, then execute. Re-evaluate admission at launch, not only at installation. Content integrity does not establish publisher trust; signatures do not automatically authorize execution.

Submission acceptance means only that a candidate was stored for review. Keep pending candidates separate from the approved catalog; reviewers may inspect/diff their bytes without executing them. The existing serve surface must authenticate submissions and enforce reviewer roles independently of the browser. The submitter must not be able to promote a candidate, replace trust roots, or forge reviewer identity through client-controlled fields.

The minimal M2 flow needs authenticated submit, list/inspect/diff, approve/reject, and promote-approved-release operations plus an audit record. A CLI or small review surface is sufficient; no enterprise workflow engine. Record the candidate digest, claimed author, verified submitting identity, publisher identity, reviewer identity, decision/time, and approval reference. Approval signs the exact candidate that was reviewed; any subsequent edit requires another candidate and decision. Review does not execute code automatically.

Artifact upload and catalog promotion are separate from execution approval. A registry may make pending blobs retrievable without making them approved; clients must reject their execution. Keep case data and private organizational audit identities out of distributed application artifacts.

## 10. Identity, approval, and trust

### Execution admission, not hostile-code confinement

The primary direction is `untrusted pod data -> verified attribution -> policy approval -> admitted execution`. Same-origin admitted code is trusted with the workbench's browser authority. Read-only mounts and narrow APIs remain valuable contracts but do not prevent that code from accessing other origin resources or making authenticated requests outside those APIs. A signature or reviewer decision cannot prove code harmless.

This deliberately replaces the earlier POC requirement to isolate every downloaded application. Unapproved code must not execute through Artipod's supported paths. Protecting the workbench from malicious code after admission is not promised in this mode. The browser owner can bypass client checks using DevTools; server authorization still enforces who can submit, approve, and distribute releases. No real sensitive data is used in the POC.

### Attribution and roles

- **Author:** claims or records responsibility for changes; distinguish a claimed name from verified submission identity.
- **Publisher:** human or organization signing the artifact for distribution.
- **Approver:** an authority trusted by the consuming environment to permit execution for a specified audience and execution mode. Publisher and approver may be the same entity, but their roles are explicit.

A company may be the public signer while its private audit trail maps the signing event to an authorized human or service and an accountable human/organizational owner. That responsible actor can be opaque to recipients; it must remain auditable by authorized organization administrators. Do not invent a human identity for automated signing. Enrollment and organizational controls establish accountability; cryptography alone does not prove a human is responsible.

Choose a maintained implementation of an established artifact-signing/attestation format compatible with OCI digests; do not invent signature envelopes, canonicalization, or cryptographic primitives. Inspect existing authority/key facilities before adding anything, but do not conflate encryption-key leases with code-signing approval or reuse their keys by default. Signing credentials stay outside pods and model context. Production PKI/SSO, organization enrollment, and transparency infrastructure are deferred; test identities and a pinned, host-configured approver trust root are enough to prove the POC.

### Layers and final composition

Layer signatures and layer review records attribute and approve particular layer bytes for a stated purpose. They can reduce repeat review, but do not automatically approve their composition. A later layer can shadow the entrypoint, replace code, or expand capabilities. The final execution approval binds the composed application digest, its descriptor, pinned executable dependency graph, declared capabilities, and execution mode. Demonstrate reuse of unchanged layer evidence plus explicit review of the changed layer and final composition.

Any changed layer order/content, executable dependency, or capability declaration creates a new approval subject. Moving a mutable tag cannot transfer approval. Signatures/approvals are external attestations over digests so adding approval evidence does not create a self-referential content digest. Case data can change independently, but it must not be interpreted as newly admitted executable code. Agent/skill definition dependencies are included in the corresponding harness admission decision.

### Local development and lifecycle

| State | What is allowed |
|---|---|
| Unknown or pending candidate | Store, inspect safely as data, diff, submit; no automatic execution or harness instantiation |
| Approved immutable release | Execute only after digest, signer trust, policy, audience, mode, and validity checks succeed |
| Local mutable development fork | Execute only under explicit user authorization for this browser/workspace and session; show development/unapproved state |
| Changed release without development authorization | Deny execution until new approval or explicit local authorization |
| Rejected, revoked, expired, or unverifiable release | Deny release execution; preserve data for inspection and recovery |

Development authorization is a separate, revocable local decision, not a publisher signature or distribution approval. It can cover a session of human/agent edits without prompting for every save, but does not silently carry across unrelated pods, new executable dependencies, enlarged requested capabilities, or a browser restart. Imported outsider content requires an explicit decision, not automatic labeling as local trusted work. Organizations may disable development execution by policy. The POC uses a distinct development session and test accounts, not real user data.

Revoking a development session stops supported reload/launch operations and disposes owned preview resources. A remote release revocation denies future launches and requests termination of managed running sessions when learned; it cannot erase data already read or guarantee containment of arbitrary trusted same-origin code. Persisted workers/caches and fallback routes must not become automatic execution paths around admission; define and test startup/reset behavior.

### Approval policy and offline use

An execution approval includes the immutable subject, approver identity, publisher evidence, intended audience/environment, execution mode, capability declaration, issue/expiry times, and a revocation identifier or equivalent reference supported by the selected format. The host supplies trusted approver roots and policy; pods cannot supply their own trust authority. Capability lists support review and host API contracts, not per-app confinement in trusted same-origin mode.

Fail closed on missing/bad signatures, unknown signers, digest mismatch, unapproved compositions, wrong audience/mode, expired approval, or known revocation. Select a concrete offline policy at M0: a cached verified approval may be used only until its signed expiry and a finite host-policy freshness deadline, whichever comes first. Missing/expired evidence denies offline release execution. Disconnected clients cannot learn new revocations immediately; display and document that bounded stale-approval window. Local development is an explicit separate path, not an automatic fallback after approval verification fails.

Use existing authorization and audit facilities where suitable. Validate broker paths, request sizes, operation permissions, and caller/session identity; those checks enforce the APIs, not isolation from admitted code bypassing them. Server reviewer authorization must survive a hostile or modified browser client. Signing keys, server approver credentials, and private accountability records must never be distributed with a pod.

## 11. Implementation phases and gates

### M0: Admission and browser runtime go/no-go

- [x] Record setup, starting revision, worktree state, and core/SPA baseline results; identify blockers before implementation.
- [x] Refresh the baseline for the revised scope; inspect existing signing/authority facilities, choose a maintained attestation implementation, and record test human/organization publisher identities, independent approver policy, pinned trust roots, and offline freshness limits. Test keys are not production identities. *(2026-09-05 baseline repairs + signing selection; D12/D13.)*
- [ ] Build the smallest reversible Artipod/OPFS-backed fixture with a separate read-only data mount and admission-aware launcher. Do not replace its execution source with a server directory. Unknown candidate inspection stays inert, including direct asset URLs and fallback routes. *(Partial: OPFS-backed launcher, inert inspection, direct-URL/fallback denial shipped in `0f3fcf6`; the read-only data mount was proven only in the retired probe — declared mounts currently block launch in the integrated path.)*
- [x] Prove a valid signed approval admits exactly its immutable release bytes; reject missing/tampered signatures, unknown signers, altered digests, wrong audience/mode, expired/known-revoked approvals, and unapproved layers/dependencies. Bind verification to the loaded immutable view to avoid mutable-tree substitution after checking. *(Automated: `lib/m0` admission matrix + `browser-runtime.test.ts` real ES256 launch/mutation/immutable-read; live: Chrome verified Node-signed evidence on the probe path. Integrated live signed replay is tracked under task 10.)*
- [x] Prove explicit workspace/session-scoped local development authorization, visible development state, saved edits, and revocation. Modified bytes do not inherit the base release's approval; failures do not silently enable development mode. Reload after browser restart requires renewed development authorization. *(Live 2026-09-06 on 2784: confirm dialog, "Development (unapproved)", saved edit invisible until Reload, Close/Stop-revoke, re-authorization required; missing policy 404 → no fallback; authorization is memory-only.)*
- [x] Prove relative modules, dynamic imports, CSS assets, and binary fetches; test root-relative URLs and source maps and record their actual support. *(Live: CSS/PNG/static+dynamic module/8-byte WASM; root-relative `/case/...` unsupported by CSP; inline source map works, external DevTools map load bypasses the worker → 404.)*
- [ ] Select and document D4: admission before projection, origin/context, defense-in-depth CSP, supported execution entry points, broker API checks, and OPFS ownership. State the ambient authority of admitted same-origin code; do not claim mounts or iframes isolate it. Test forged admission/session messages, direct-route bypass, and broker path escapes. *(Partial: candidate shipped and documented in `execution-preview.md`; `runtime-worker.test.ts` + `static.test.ts` cover owner/guest/path/prefix denial. Full forged-message/fallback/startup/entrypoint audit and the final D4 record are open. Known defect: catalog-navigation launch times out until the workspace is reloaded.)*
- [ ] Prove saved-edit reload under development authorization, file persistence across host reload, disposal, and denial of stale/revoked launch/broker sessions. Test expired/missing offline approval and valid bounded cached approval; record browser versions and limits of revocation. *(Partial: reload/persistence/disposal/stale-URL 403 proven live; offline cached approval and remembered revocation not yet ported from the probe to the integrated runtime.)*
- [ ] Prove Chrome DevTools for a running admitted application: recognizable scripts in Sources, a breakpoint and inspected variables, Network-visible mounted reads, source-map resolution, and new saved source after reload. Host-side downloads alone do not satisfy this check; DevTools edits are not automatic pod writes. *(Partial: CDP breakpoint + variables on projected `main.js` and post-edit reload proven; visible mapped Sources replay and mounted-read Network evidence open — the latter depends on task 3.)*
- [ ] Run section 12's full phase checks and browser procedure; paste commands/results into the M0 worklog and update the decision register and tracker.
- [ ] **Done when:** ordinary assets and debugging work from OPFS; supported launch paths execute only a verified approved release or explicitly authorized local development; tampering, unapproved execution, and stale authorization checks fail closed. Trust and offline limits are documented, all checks pass, and `docs(plan): model-exec phase M0 gate` is ready. Existing isolation experiments are not evidence of this revised gate. Obtain owner sign-off before relaxing admission requirements.

### MA: Apps layer, process namespaces, `ps`/`kill` (owner-requested, in PR #57)

Owner direction 2026-09-06: the runtime must be a tidy layer other sites can
adopt, not `lib/m0` spaghetti, and running apps must be visible and killable
from the shell. D15/D16 record the choices. This phase re-homes what M0 built;
it does not relax any M0 admission requirement or earn the M0 gate.

- [x] Move descriptor parsing, application capture (`application-files` +
  `release-view`), admission, browser runtime, lifecycle/telemetry protocol
  and the service worker into `src/apps/`, exported as `@artipod/core/apps`.
  Imports only public core barrels (`../oci/index.js` etc.), browser-safe,
  no SPA/React/zustand-store coupling beyond `zustand/vanilla`. Tests move
  with the code; `lib/m0/fixtures.ts` becomes a core test fixture. `jose`
  moves to core dependencies. Add a `./apps` weighbridge entry. *(`2f35fa7`;
  zustand dropped entirely — `createSnapshotStore` is shape-compatible with
  `useStore`.)*
- [x] Ship the service worker as a dist asset (`dist/apps/runtime-sw.js`);
  the SPA's existing asset prebuild copies it to `public/artipod-runtime-sw.js`.
  No consumer has to vendor the worker by hand. *(`2f35fa7`; also exported
  as `@artipod/core/apps/runtime-sw.js`.)*
- [x] `ProcessTable` in `src/proc/processes.ts`: namespace-local pids, uuid
  identity, kinds `shell` / `app` / `task`, per-kind `signal()` with `ENOTSUP`,
  change subscription, downward-only visibility, cascade on dispose. A
  `/proc/<pid>/{status,cmdline}` provider (root `''`) plus `/proc/self`.
  *(`ed56df7`; `/proc/self` dropped — the snapshot has no symlinks and the
  shell's pid is in `ps`.)*
- [x] `ps` and `kill [-STOP|-CONT|-TERM|-KILL] <pid>` in
  `src/sandbox/process-command.ts`, registered when a table is supplied via
  `CreateSandboxOptions.processes` / `ZenFsPodOptions.processes`. The shell
  registers itself as a `shell` process; `tasks` render as bracketed `task`
  rows (`artipod ps` stays as the task-detail view). *(`ed56df7`; `Sandbox.dispose()`
  added so short-lived shells retire their row.)*
- [x] The apps runtime registers each launched instance as an `app` process
  (name, pod/ref, mode, digest, state, telemetry); `STOP`/`CONT` drive the
  cooperative lifecycle, `TERM`/`KILL` close. `ApplicationPreview` reads
  lifecycle state from the process, not component-local controller state.
  *(`ed56df7`; `runtime.attach()` / `runtime.report()`, pid shown in status.)*
- [x] Re-home the sample to `examples/lifecycle-app/`; delete
  `examples/artipod-spa/m0-preview` and `lib/m0`; move
  `execution-preview.md` to `docs/apps.md` as the consumer runbook (install
  the subpath, serve the worker at `/`, wire a `ProcessTable`, render your UI).
- [x] Verify: core lint/build/tsc/tests, SPA lint/typecheck/tests/export,
  weighbridge with the new entry; live on 2784: `ps` lists shell + running
  app, `kill -STOP` freezes it (same as the Stop button), `kill -CONT`
  resumes, `kill <pid>` closes and the preview reflects it; `cat
  /proc/<pid>/status` shows the app. Record evidence in the worklog.
  *(See the 2026-09-06 MA worklog.)*
- [x] **Done when:** no `m0` path remains outside historical worklog text,
  the SPA imports the runtime only from `@artipod/core/apps`, `ps`/`kill`
  and `/proc/<pid>` work against real running apps, and all gates pass on
  PR #57. Nested (child) namespaces are designed for, not built: today one
  table per pod session; apps that launch sub-apps are a later phase.
  *(Remaining `m0` strings are synthetic test identity/fixture names.)*

### MB: Inventory depth — `-v`/`-vv`, hydration, `--json`, `/proc` manifests (owner-approved, in PR #57)

Follows the D17 glossary discussion. Per-file layers are a strength (per-file
attribution, CAS dedup, LWW merge) but must not be shoved at Docker-fluent
users by default; hydration state is shown, not hidden; machine output uses
the real artifact where one exists. Each commit updates this plan.

- [x] `images -v` becomes summary-first: paths/alias/remote/parents plus one
  line `N file layers · size · K local / M lazy · by actor`, then **what
  changed since the parent** (layers in head not in parent, via
  `org.artipod.parents`) — the `git show --stat` of an image. `-vv` (or
  `-v <ref>`) shows the full stack, each row marked `●` local / `☁︎` lazy
  using the local store's `hasBlob`. Same for `artipod images`. *(This
  commit; an unreadable parent says so rather than hiding the line.)*
- [x] `--json` on `images`, `volumes`, `ps` (and `artipod images|volumes|ps`):
  JSON Lines, one object per row, shaped exactly like the exported
  `ImageRow` / `VolumeRow` / `ProcessInfo`; `images -v <ref> --json` emits one
  `ImageDetail`. No separate schema document; the TS types are the schema.
  *(This commit. Renamed from `lsblk` after finding the shell's real `lsblk`/`mount`.)*
- [x] `/proc/images/<slug>/manifest.json` = the raw OCI manifest bytes (the
  honest machine view; `jq '.layers[].annotations["org.artipod.path"]'` works
  with the shell's existing `jq`). `status` stays the human view. *(This
  commit; `status` also gains `Hydrated: k/n`. just-bash ships `jq` — verified
  on 2784 via `/api/exec`.)*
- [x] Docs: `docs/apps.md` inventory section gains the flags, a jq example,
  the D17 glossary table, and the plaintext-server / encrypted-local
  `.alias` note. Worklog records live output.
- [ ] **Done when:** the four items above are live-verified on 2784 against
  real refs (a pulled encrypted fork, an unpulled plaintext pod, a >100-layer
  pod), core/SPA gates pass, and the glossary is in the docs. Renaming
  `image history` → `image layers` and fixing `commit` granularity are
  recorded in D17 as follow-ups, not done here. *(Live verification recorded
  below; awaiting owner review of the output shape before checking.)*

### M1: Semantic discovery and simple composition

- [ ] Finalize D3 and implement descriptor validation/discovery for the required profiles without breaking the existing mount API or creating duplicate metadata authorities.
- [ ] Create synthetic CasePod and Case Viewer SPAPod fixtures with the layouts and data in section 8; add malformed-descriptor and valid-case tests.
- [ ] Resolve requested compatible mounts through the host; enforce the filesystem API's read-only contract and test path/encoding escapes without claiming malicious-app confinement. Expose the source descriptor, resolved mounts, verified attribution, approval subject, and current development/release state for inspection.
- [ ] Integrate discovery, case selection, admission, development authorization, and one active preview into the existing services/stores and UI. Reuse filesystem events for data refresh and authorized development reload; changed release code requires a new admission decision.
- [ ] Prove composition with memory-backed tests and real OPFS execution; update relevant docs to distinguish semantic descriptors from concrete mount manifests.
- [ ] Run section 12's full phase checks and browser procedure; record evidence, deviations, and tracker status.
- [ ] **Done when:** both pods are independently recognizable, the app displays a mounted case without embedded case data, saved edits update the view, semantics work independently of OPFS, and `docs(plan): model-exec phase M1 gate` records passing evidence.

### M2: Submission, review, and approved distribution

- [ ] Select and record the existing snapshot/publish/pull and server authorization APIs, pending/released test destinations, reviewer role, audit storage, and clean-environment procedure. Resolve D6 without adding a package protocol or treating upload as approval.
- [ ] Snapshot a saved application revision with writes stabilized; test that only application-owned files and its descriptor enter the artifact, excluding mounted case data, host metadata, grants, and credentials.
- [ ] Sign/attest the immutable candidate with a test human or organizational publisher identity and submit it through authenticated server APIs into pending review. Separate claimed author from verified submitter/publisher; keep the organization's responsible actor in a private audit record. No signing secrets or private identities enter the application artifact.
- [ ] Implement minimal reviewer inspect/diff and approve/reject operations in the existing serve surface. Server-enforced roles prevent submitters, browser edits, and agent tools from self-approving. Review never automatically executes pending code. Demonstrate rejection as well as approval.
- [ ] Demonstrate signed layer attribution and reuse of an approved base layer's review evidence. A changed layer, layer ordering, entrypoint, executable dependency, or capability declaration requires approval of the final composition; test that individually approved layers alone do not admit a new combination.
- [ ] Approve the exact reviewed final digest and promote only that release to the approved test catalog. Record immutable subject, signer/reviewer, audience/mode, capability declaration, validity/revocation reference, and audit decision. Changing a tag or swapping bytes after review must not carry approval forward.
- [ ] In a clean browser environment without original OPFS contents, show that the pending candidate cannot launch as a release; after approval, verify the artifact and evidence, select a different synthetic CasePod, and run it. Test wrong audience, revoked/expired approval, and tampered evidence/content on the consumer path.
- [ ] Record exact submit/review/approve/reject/promote/install commands and artifact-content assertions; run section 12's full phase checks and update worklog/tracker.
- [ ] **Done when:** a browser-created candidate remains non-executable for recipients until server-authorized review approves its exact composition; approved edited assets survive clean installation, forbidden data stays out, accountability/layer evidence is demonstrated, and `docs(plan): model-exec phase M2 gate` records passing evidence.

### M3: Agent-driven case and application edits

- [ ] Confirm and record the owner-approved harness/provider integration and capability names before coding it; record model prerequisites and context-disclosure consent without secrets.
- [ ] Create AgentPod, `AGENT.md`, and both discoverable skill definitions; verify their composition approval or explicit development authorization before loading into the existing harness. Do not embed a harness or retain only the panel's fixed instructions; unapproved definitions stay inert.
- [ ] Broker approved filesystem operations for the case and application; test denied paths, grant escalation, and any shell bypass. Keep credentials and host configuration outside the agent namespace.
- [ ] Test skill-guided discovery, notes/status/priority/timeline mutations, and application source edits with deterministic tool-loop tests. Preserve valid CasePod structure.
- [ ] Run both real model-driven interactions from section 13 under development authorization; show changed files, updated case data, reloaded application, and unapproved-fork state. Submit the result, obtain separate reviewer approval, and repeat approved distribution/clean installation. Test denial of agent self-approval and access to signing credentials.
- [ ] Run section 12's full phase checks; distinguish live evidence from mocked tests in the M3 worklog and update the tracker.
- [ ] **Done when:** the admitted live agent edits only the pods authorized through its harness tools, both skills produce visible development changes, and the new app revision passes separate submission/review/approval before recipient execution. `docs(plan): model-exec phase M3 gate` records passing evidence. Fake-model tests alone cannot satisfy this gate.

### M4: Multiple-app proof and documentation

- [ ] Add a second minimal viewer compatible with the same CasePod profile, using the shared discovery/mount/runtime path rather than special-case APIs.
- [ ] Prove independent app/subject selection and switching with one active preview; verify each application's admission separately, preserve case data, and dispose the previous managed preview/session. Do not claim hostile-code termination or isolation.
- [ ] Finish README coverage in section 14: signing versus approval, layer versus composition review, local development, pending versus approved distribution, offline/revocation limits, trusted same-origin authority, runtime support, and exact simple/complex demo commands. Clearly label restricted execution as deferred.
- [ ] Replay the complete section 13 demonstration from a documented setup, including the second viewer, and record reproducible evidence.
- [ ] Run section 12's full phase checks; reconcile every section 14 acceptance box against phase evidence and update the tracker/worklog.
- [ ] **Done when:** applications and subject pods are independently selectable, the full simple/complex workflow is reproducible, all acceptance boxes are earned, and `docs(plan): model-exec phase M4 gate` records passing evidence. Concurrent independent workspaces and a marketplace remain out of scope.

## 12. Verification

Automate the following at the owning layer:

- Descriptor detection, version validation, malformed fields, and supported profiles.
- Mount resolution, read-only enforcement, path traversal/encoding cases, and data independence.
- CasePod reads and valid skill-driven file mutations.
- HTML/module/CSS/asset resolution, dynamic imports, binary fetches, and documented root-relative behavior.
- Browser execution from real OPFS-backed Artipod files, reload after saves, and persistence after host reload.
- Admission before execution across launcher/direct projection/worker/harness entry points; safe inert inspection of pending pods.
- Signature and trust-root verification; missing/tampered evidence, unknown signer, wrong audience/mode, expired/known-revoked approval, and digest substitution denied.
- Layer attribution, final-composition approval, changed dependency/capability/order invalidation, and mutable-tag movement without inherited approval.
- Explicit local-development authorization, edited-fork status, denial after revocation/restart, and no automatic development fallback after failed release verification.
- Server-side submitter/reviewer role separation, pending/reject/approve/promote transitions, exact reviewed bytes, and private organizational accountability records.
- Broker message forgery, API path permissions, stale sessions, disposal, and bounded offline freshness. These do not establish same-origin hostile-code confinement.
- Application-only snapshot contents, coherent saved revision, digest verification, and clean-environment retrieval.
- Agent definition/skill loading, scoped tool calls, and negative tests for unauthorized operations.
- App switching and reuse of one CasePod by two compatible viewers.

Run focused checks while implementing. Every phase ends with the full core gate from the SPA plan, run at repository root:

```sh
npm run lint && npm run build && npx tsc --noEmit && npm run test
```

Also run the SPA's own lint, typecheck, tests, and build using its current package scripts, recording the exact commands. This is a phase gate even when the phase's core change is small: preview integration must preserve the shipped workbench. Build core before CLI tests because they spawn `dist/cli.js`. Preserve the static-export struct-minify assertions. Run applicable repository CI requirements, including the existing weighbridge budget check when runtime/package changes affect measured outputs; do not relax budgets to conceal a regression.

Browser checks use a real encrypted local serve, desktop/mobile viewports, and both existing light/dark themes for UI changes. Drive filesystem changes through the existing pod escape hatch where terminal keyboard automation is unreliable. Record the actual procedure and results, not merely "manual check passed."

Record commands, results, browser versions, and deviations in a worklog as execution proceeds. No passing claim without evidence; distinguish mocked checks from real browser, transport, and model runs. Do not deploy the sample site or publish an npm release without separate approval.

## 13. Final demonstration script

The implementation must supply exact setup, launch, publish, and install commands using the mechanisms selected in M0-M2. Do not invent runnable commands before those mechanisms exist.

1. Open the workbench and launch an approved Case Viewer release against synthetic Case A. Show its descriptor, verified publisher and approver, exact digest, app files, and resolved read-only case API mount. Confirm OPFS-backed execution and normal Sources/debugging behavior.
2. Create a local application fork and explicitly authorize development for this browser/workspace session. Show that modified code is not the approved release. Admit the supplied AgentPod/skills, configure its approved filesystem tools and model provider, and instantiate it.
3. Ask: "Add a note that we spoke with the customer today, set priority to high, and mark the case as in progress." Show the changed files and updated viewer.
4. Ask: "Change the application so high-priority cases display the priority prominently beside the title, and show the newest timeline item first." Show actual application source changes and the reloaded preview.
5. Snapshot the modified SPAPod, sign/attest its attribution, and submit its immutable digest to the server's pending review area. Verify Case A and credentials are absent. Show the changed layer and reused base-layer evidence; neither local authorization nor layer signatures approves the final release.
6. In a clean recipient environment, demonstrate that the pending candidate cannot launch as an approved release. As a separately authorized reviewer, inspect the diff and approve the exact final composition for the intended audience/mode. Promote it to the approved test catalog with an auditable decision.
7. Install the approved digest and evidence in the clean environment, verify admission, create/select synthetic Case B, resolve its mount, and run the modified application. Show that a tampered revision or moved tag is not admitted by the old approval.
8. Open a separately approved second viewer against Case B to demonstrate independent application selection.

The simple demonstration uses steps 1-2 and 5-7 with human edits and no agent instantiation. The complex demonstration runs the complete sequence. Reviewer and signing steps use test identities/destinations only unless public distribution is separately approved.

## 14. Deliverables and acceptance

- [ ] Updated main README: vision, taxonomy, storage/runtime distinction, execution matrix, composition, browser-local development, signing/approval roles, layer review, server submission, approved distribution, offline limits, harness roles, diagrams, and runnable instructions. Explicitly disclose trusted same-origin authority and deferred hostile-code isolation. **Evidence: M4.**
- [ ] Minimal semantic descriptor/profile implementation, preserving existing mount APIs. **Evidence: M1.**
- [ ] Synthetic CasePod and independently packaged Case Viewer SPAPod. **Evidence: M1.**
- [ ] OPFS-backed admission-gated runtime integrated into the trusted workbench, with explicit local-development authorization and verified Chrome Sources/debugging. **Evidence: M0-M1.**
- [ ] Application-only immutable candidate, signed attribution, server-side review/approval, approved distribution, and clean-environment execution proof. **Evidence: M2 and M3.**
- [ ] Human/organizational test identities with private accountability audit, layer attestations, and mandatory final-composition approval. **Evidence: M0 and M2.**
- [ ] Negative admission tests for unapproved/tampered/expired/revoked releases, offline validity limits, and denial of submitter/agent self-approval. **Evidence: M0-M3.**
- [ ] AgentPod and two declarative skills consumed by the existing harness path. **Evidence: M3.**
- [ ] Second minimal viewer proving multiple-app compatibility without hardcoded ownership. **Evidence: M4.**
- [ ] Automated tests, real browser/security evidence, live agent demonstration, and exact demo script. **Evidence: M0-M4, consolidated in M4.**

Success means humans and agents share an explicitly authorized local development workspace; they can propose immutable applications for accountable review, and recipients execute only approved compositions independently of subject data. It does not require a universal runtime, deep class hierarchy, browser-native execution, full plugin system, browser build farm, production PKI, hostile-code confinement, or self-modifying installed workbench.

## 15. Risks and landmines

| Risk | Phase | Mitigation / stop condition |
|---|---|---|
| Same-origin execution mistaken for isolation | M0 | Approve admission explicitly; disclose ambient authority; do not claim mounts/CSP isolate admitted malicious code |
| Signature or trusted layer mistaken for final execution approval | M0, M2 | Separate attribution from approval; bind final composition/dependencies/capabilities; deny tag/digest substitution |
| Approval verified before mutable bytes change | M0, M2 | Immutable verified release views; local edits use development authorization, never inherited approval |
| Pending upload automatically becomes executable or distributed | M2 | Server role enforcement, separate pending/approved catalog transitions, exact reviewed digest |
| Same-origin app alters approval UI or launches code outside managed paths | M0 | Trust admitted code; enforce reviewer roles server-side; admit that client checks cannot contain already trusted malicious code |
| Revocation assumed immediate while offline or after code has run | M0, M2 | Signed expiry plus bounded freshness; deny stale launches; document cached window and no data clawback |
| A second descriptor becomes a competing concrete mount API | M1 | Keep semantic requests separate from existing `PodManifest`; one authoritative descriptor, projections only |
| ZenFS/proc singleton ownership leaks across previews | M1, M4 | One active preview, explicit teardown, stale-grant tests; no concurrent-workspace expansion |
| A composed snapshot includes subject data or partial source edits | M2 | Application-owned snapshot roots, stabilized writes, artifact inspection and clean-install tests |
| Model instructions are mistaken for permission enforcement | M3 | Host-enforced scoped tools, shell-bypass tests, denied-path tests, separate provider consent |
| Deferred external harness integration blocks the live proof | M3 | Confirm entry point/provider before coding; record blocker rather than claiming fake-model parity |
| Built workspace assets are mistaken for editable browser-runnable source | M4 / future | Plain modules in the POC; defer browser build tooling and trusted-host promotion |
| Static export, copied core dependency, or minification regresses | Every gate | Follow SPA AGENTS/build scripts, retain struct-minify assertions, run full core/SPA gates |

## Worklog

M0 started on 2026-09-05 at the owner's request. No phase gate is earned yet. For each phase, record dated progress, exact commands and one-line results, browser evidence, decisions/deviations, blockers, and the gate result (plus commit hash when committed). Never record credentials or real subject data.

### 2026-09-06 - MB fix: `lsblk`/`mount` collision → `volumes`

- Owner asked why `mount --help` did not explain mounting. Cause: my inventory
  `lsblk`/`mount` had **shadowed** the sandbox's existing storage commands
  (`mount -t memory|idb|opfs`, `umount`, `lsblk`, `df`, `findmnt` over ZenFS
  backends; `src/sandbox/storage-command.ts`, covered by `proc.test.ts`).
  Removed the shadowing commands; the workspace listing is now `volumes`
  (`-m`, `--json`; `artipod volumes`). The real `mount --help` gained a
  pointer to `artipod image mount <ref> [path] [--through N]` (read-only lazy
  view) and `artipod open <ref>` (writable cow overlay). Test asserts `mount`
  prints the mtab and `lsblk` the origin-quota table. D17 records the rule.
- Answer to "can we mount containers / see what the server offers": `images`
  lists the server; mounting happens inside a workspace shell via the pod
  verbs above. There is no server-side container mount from the browser —
  images materialize into ZenFS (lazy layers, hydrated on read).

### 2026-09-06 - MB: `-v` summary + parent diff, `-vv` hydration marks, `--json`, `/proc` manifests

- `ImageDetail` gains per-layer `local` (store `hasBlob`), `changed` (layers
  not in the first parent's manifest), and `manifest` (raw text). `images -v`
  prints paths/alias/remote/parents, one summary line with hydration counts,
  then the parent diff; `-vv` / `-v <ref>` the full stack with `●`/`☁︎`.
  `--json` JSONL on `images`/`lsblk`/`mount`/`ps` and `artipod images|lsblk|ps`;
  `images -v <ref> --json` = one `ImageDetail`. `/proc/images/<slug>/manifest.json`
  projects the raw manifest when readable; `status` adds `Hydrated`.
  Completers list `-v -vv --json` and refs. Shared `runImages`/`runVolumes`
  so the three entry points cannot drift.
- Live on 2784 (workspace shell over `samples/lifecycle:_3` cow): case pod
  `13 file layers · 826.2 kB · 0 local ● 13 lazy ☁︎ · by examples-builder`;
  `doug:_1` `308 file layers · 1.6 MB · 0 local ● 308 lazy ☁︎`, parent diff
  first rendered as an empty `changed nothing` because the parent manifest was
  not readable (404 on the server, not pulled) — fixed to say so explicitly;
  `samples/lifecycle:_3` `9 file layers · 1 local ● 8 lazy ☁︎` with the
  `.alias` line and "no parent — first head". `jq -r '.layers[-2:][].annotations["org.artipod.path"]'
  /proc/images/doug__1/manifest.json` → `/u7-parity.md`, `/secret-note.md`.
  `images --json` and `ps --json` rows parse as `ImageRow`/`ProcessInfo`.
- Gates: core lint/tsc/build, 638 tests (10 inventory); SPA typecheck/lint/
  export PASS; bundle swapped. Not pushed.

### 2026-09-06 - MA follow-ups: catalog console, fork labels, inventory, completion, `images -v`

- `af7f817` catalog root console gets its own `catalog` namespace (pid 1 +
  itself) so `ps`/`kill` exist there too. `a1594f6` cow fork rows are named
  by basis (`<ref> (fork)`), not by the suggested publish tag — three forks
  had all rendered as `samples/lifecycle:_4`.
- `e64fa03` inventory: `InventoryProviders` → `images` (server refs) /
  `lsblk` (local workspaces, MOUNTPOINT set only while a tab holds the
  workspace Web Lock) / `mount`; `/proc/images/<slug>` + `/proc/workspaces/<slug>`;
  pod `artipod` gains `images`/`lsblk`; a pod-less `artipod` (images/lsblk/ps
  + help) for consoles without a pod. SPA `lib/services/inventory.ts` derives
  rows exactly as `Catalog.tsx` does and reads the registry file directly.
- `dbe239d` tab completion: `compgen` never knew the custom commands;
  `Sandbox.complete()` adds them and honours per-command completers
  (`withCompletion`, `verbTree`): `art⇥`, `artipod ⇥`, `artipod image ⇥`,
  `kill -⇥`, live pids, flags. `0e93d2c` `images -v`: local blob path,
  `.alias` twin, remote URL, parents, layer stack with path/mtime/actor/
  overlay; listing caps at the top 8, `images -v <ref>` in full.
- Live on 2784: `images -v ghcr.io/…/case:latest` showed 13 file layers by
  `examples-builder` with story dates; `doug:_1` 308 overlay layers from four
  browser actors; `samples/lifecycle:_3` plaintext on the server but with a
  local `.alias` (this tab's store encrypts everything it writes) — recorded
  as a doc note for MB. `parents` arrived as a JSON array, not CSV; fixed.
- Gates at `0e93d2c`: core 636 tests, lint, tsc, build; SPA lint/typecheck/
  29 tests/export. Not pushed since `e64fa03` per owner instruction.

### 2026-09-06 - MA: apps subpath, process namespaces, `ps`/`kill`

- `2f35fa7` extracted the runtime into `src/apps` → `@artipod/core/apps`
  (descriptor, capture, admission, runtime, lifecycle, telemetry, worker),
  with 90 tests relocated (SPA 119 → 29; core 532 → 622). The runtime store
  is a framework-free `createSnapshotStore`; zustand is no longer a runtime
  dependency. `jose`/`core-js` moved to core `dependencies`; `./apps`
  weighbridge entry (120 KB gzip budget). Worker ships as
  `dist/apps/runtime-sw.js`; the SPA prebuild copies it to `public/`.
  Sample → `examples/lifecycle-app/` with its VM test; runbook →
  `docs/apps.md` rewritten for consumers.
- `ed56df7` added `ProcessTable` (`src/proc/processes.ts`): pid 1 = session,
  rows for `shell` / `app` / `task`, per-kind cooperative signals with
  `ENOTSUP`, cascade on `dispose()`, `/proc/<pid>/{status,cmdline}`
  provider. `ps [-l]` / `kill [-SIG] <pid>...` in
  `src/sandbox/process-command.ts`; `CreateSandboxOptions.processes` +
  `ZenFsPodOptions.processes`; shell rows track exec state and cwd;
  `Sandbox.dispose()` retires a row. Apps runtime spawns an `app` row per
  launch with `attach()`/`report()` so `kill -STOP/-CONT` reach the iframe's
  lifecycle controller and its acks flow back to the row and the snapshot.
  SPA `pod-session` owns the table (registered provider, disposed on close),
  `[sync:push]` is a task row, `ApplicationPreview` shows the pid and reads
  lifecycle from the store. JWS statement types renamed
  `artipod-apps-*+jws` / `artipod.apps/v1`.
- Checks: core lint PASS, `ARTIPOD_NO_DEVLINK=1 npm run build` PASS,
  `npx tsc --noEmit` PASS, `npm test` PASS (60 files / 629 tests); SPA lint,
  nonincremental typecheck, tests (4 files / 29) and `export:static` with
  assertions PASS. `ARTIPOD_NO_DEVLINK=1 npm run weighbridge`: first run
  reported `./apps` **OVER** at 349.6 KB gzip because `capture.ts` imported
  the `/oci` barrel (isomorphic-git and friends). Switched to the
  dependency-free leaves `oci/digest` + `oci/tar` → 19.2 KB gzip, 17 ms
  import; budget set to 30 KB. All other budgets unchanged and met
  (tarball 4.30 MB, root gzip 595.0 KB).
- Live on 2784 (`samples/lifecycle:_3`, cow, dev-authorized): `ps -l` listed
  init / bash / `[sync:push]` / `Lifecycle sample` (pid 4, pod, mode, digest,
  url, elapsed, retained). `kill -STOP 4` froze the allocation (same value
  2.5 s apart), toolbar flipped to Resume + "Suspended by you", `ps` showed
  `suspended`, `cat /proc/4/status` showed the row. `kill -CONT 4` resumed
  and allocation grew. `kill -STOP 3` (task) and `kill 99` reported
  `Operation not supported` / `No such process`. `kill 4` closed the app:
  iframe removed, status `Closed`, row gone. Ad-hoc shells created per
  command leaked rows until `Sandbox.dispose()` was added; re-verified
  after the fix. Test tab released to `about:blank`.
- Not done here (unchanged M0 gaps): CasePod mount selection, D4 record and
  bypass audit, offline cache/revocation port, mapped Sources replay,
  catalog-navigation grant timeout. Nested namespaces are designed for
  (`ppid`, uuid identity) but only one table per session exists.

### 2026-09-06 - MVP commit and M0 checklist reconciliation

- Committed the browser runtime MVP on `main` as `0f3fcf6` (46 files; core
  532 tests, SPA 119 tests, lint/typecheck/export gates green; not pushed).
  Owner-owned `git-plan.md` and `cloud-container-plan.md` left untracked.
  Pre-commit cleanups: `static.ts` indentation, removed stale
  `public/m0/test-admission.json` references and the empty `public/m0/` dir.
- Reconciled the M0 checklist against the worklogs above: tasks 2, 4, 5, 6 now
  checked with their evidence; tasks 3, 7, 8, 9 annotated as partial with the
  exact open items; tasks 10-11 remain open. Tracker and D4/D12/D13 updated;
  D14 added for the Stop/Resume/Close lifecycle decision. This is a status
  reconciliation, not a gate: no `docs(plan): model-exec phase M0 gate` yet.
- Open before the M0 gate: (a) integrated CasePod read-only mount selection
  (task 3); (b) D4 record + forged-message/fallback/startup audit and the
  catalog-navigation grant timeout (task 7); (c) offline cached approval and
  revocation memory in `browser-runtime.ts` (task 8); (d) visible mapped
  Sources and mounted-read Network replay (task 9); (e) full section 12 run
  including weighbridge on the final bundle (task 10).

### 2026-09-06 - Stop suspends in place; Close tears down

- Owner corrected the earlier contract: Stop must keep the app visible with its
  timer and allocation suspended. Selected Stop / Resume plus a separate Close.
  Added an acknowledged same-origin `artipod:runtime-lifecycle/v1` protocol
  (readiness query, suspend/resume requests, correlated acks with telemetry)
  in `lib/services/runtime-lifecycle.ts`; the sample answers it, tracks active
  time only, and keeps one interval. Unsupported or unresponsive apps are shown
  as such, never as suspended; approval expiry and Close still revoke. Runtime
  admission, worker, and `runtime.stop()` teardown are unchanged (now "Close").
- Checks: focused lifecycle/telemetry/sample tests PASS (21); SPA nonincremental
  typecheck, lint, full tests (14 files, 119) and `export:static` with
  assertions PASS. Served bundle refreshed with backup. Server ref
  `samples/lifecycle:_1` was still the untouched import, but the owner's COW
  fork may hold edits, so the updated sample was imported as
  `samples/lifecycle:_2` (no ref overwritten).
- Live on `samples/lifecycle:_2` (cow, 2784): Stop at 15 s / 224 KiB froze app
  and workbench readings for 4+ s with the counter disabled and the same
  iframe; Resume continued from 15 s without a jump; Files/focused view kept the
  suspended frame; Reload started at 0; Close removed frame and metrics, old
  URL 403. Six toolbar buttons fit at 390px. Direct workspace deep link launched
  fine; the catalog-navigation grant timeout remains a separate open blocker.

### 2026-09-06 - app lifecycle sample and reported memory

- Owner requested a sample-owned interval that updates elapsed time and slowly
  retains heap allocations, plus app-specific readings in the workbench.
  Added the durable static `examples/artipod-spa/m0-preview` sample: 16 KiB of
  touched buffer bytes per second, capped at 8 MiB, with an elapsed clock and
  volatile counter. Teardown clears its interval and retained references.
- Optional versioned telemetry is accepted only from the current iframe and
  origin, with numeric bounds and a one-second rate limit. Workbench readings
  are labeled "App-retained memory (reported)": app-reported buffer bytes,
  not total JavaScript heap, DOM, process memory, or an isolation guarantee.
  Uninstrumented apps have no readings; Stop removes readings rather than
  falsely reporting zero. Browser garbage collection timing is not promised.
- Checks: `npm --prefix examples/artipod-spa run test --
  lib/services/runtime-telemetry.test.ts tests/lifecycle-sample.test.ts` PASS
  (17 tests, including the cap and real sample capture); SPA nonincremental
  typecheck and lint PASS; full SPA tests PASS (13 files, 115 tests);
  `export:static` PASS including struct-minify and baked-version assertions.
  Editor diagnostics for the touched TypeScript files are clear.
- Final `git diff --check` and `ARTIPOD_NO_DEVLINK=1 npm run weighbridge` PASS:
  tarball 4.26 MB, unpacked 20.02 MB, UI 18.40 MB, root gzip 594.2 KB;
  all budgets met. Removed the temporary browser import JSON from `dist-ui`.
  Main 2784 remains running with the refreshed bundle; no commit or push.
- Live main-origin sample: new browser-local blank `d621106c`, descriptor name
  "Lifecycle sample". Existing `ba772299` and all five server refs preserved.
  App and workbench both showed 80 KiB at five seconds. Files/Run/focused view
  retained the iframe, allocation and counter. Reload reset bytes, clock and
  counter to zero; Stop removed frame and telemetry, and old URL returned 403.
  Restart required explicit development confirmation. PNG decoded and static
  module, dynamic module and eight WASM bytes loaded. Desktop dark (1280x800)
  and mobile light (390x844) screenshots showed no horizontal overflow.
- Browser regression found during verification: opening from a freshly loaded
  catalog twice produced "Runtime worker grant timed out"; reloading the
  workspace before development authorization succeeded. Suspected interaction
  between client-side navigation and the worker owner-URL check, not yet proven
  or repaired. No admission restriction was relaxed. This remains a runtime
  blocker; the lifecycle evidence does not pass the overall M0 gate.

### 2026-09-06 - owner-requested main catalog integration

- Owner requested Run on executable pods in the main listing, default workspace
  preview, optional app-focused view on the same origin, and explicit local
  development confirmation. Authorized implementation and a restart of local
  2784 with the original `--encrypt` options, preserving store and authority.
  This is a narrow M1 discovery/UI sequencing amendment, not an M0/M1 gate.
- Added strict SPAPod parsing, bounded inert OCI/local-blank discovery, immutable
  selected-pod capture, a session-owned runtime, catalog Run, workspace preview,
  Run/Reload/Stop controls, and same-tab focused mode. Root-scoped service worker
  intercepts only `/_artipod/run/`; static server denies that prefix when no
  worker grant handles it. No `/api/exec` integration or secondary FS session.
- Main server: `node dist/cli.js serve --port 2784 --encrypt`, same five existing
  refs and existing `~/.artipod/{store,authority}`. Old bundled UI backed up in
  temporary `artipod-ui-backup.j4NaVKmVoV/previous-ui`. Old Next 3603 stopped.
  Local public test admission fixture moved to `artipod-local-admission.6Bej4rHBx4`
  outside the export. No server pod was published or overwritten.
- Live browser at `http://127.0.0.1:2784/`: created new browser-only blank
  `ba772299` named by its descriptor "M0 local preview". Catalog Run opened
  `/?artipod=ba772299&run=1`; no iframe before explicit development confirmation.
  HTML/CSS, static and dynamic modules, and counter interaction worked. Focus
  toggle retained URL/session/state; saved edit remained invisible until Reload;
  Reload changed snapshot digest and old URL returned 403. Stop removed iframe
  and denied old URL. Missing host policy returned 404 with no development
  fallback. Desktop dark and mobile light screenshots taken; no horizontal
  overflow or clipped preview buttons at 390px. An already-open tab initially
  retained the prior bundle; reload fixed it (not a discovery defect).
- Checks: root `npm run lint && ARTIPOD_NO_DEVLINK=1 npm run build && npx tsc
  --noEmit && npm run test` PASS, 532 tests. SPA lint PASS; nonincremental
  typecheck PASS; final 93 SPA tests PASS; export PASS (struct-minify and
  baked-version assertions, only `/` and not-found routes remain).
  Focused runtime tests PASS, 7 cases including real independent ES256 launch,
  immutable bytes, missing policy, changed composition, cancellation and expiry.
  Discovery tests PASS, 4 cases over real OCI layers and whiteouts. Retired old
  probe route/worker/launcher tests after integrated local launch succeeded.
- Remaining, not silently passed: explicit CasePod mount selection (declared
  mounts block launch), offline approved launch/revocation memory port,
  local-only OCI/fork catalog classification, integrated signed browser and
  source-map replay. Old probe
  evidence below does not prove these new-path behaviors. M0 remains pending.
- Final main-origin checks: PNG decoded at natural width 2, WASM response 8
  bytes; CDP breakpoint in projected `main.js` line 5 inspected live `value: 1`
  and `label: "Saved revision modules"`. Returning to catalog removed the frame
  and old URL returned 403. Initial debugger harness attempt used unavailable
  outer-sandbox timer globals; resumed the target and repeated successfully
  with CDP event handling. This was a test-harness error, not an app freeze.
- Final refreshed `dist-ui` footprint: `ARTIPOD_NO_DEVLINK=1 npm run weighbridge`
  PASS, all budgets unchanged; tarball 4.26 MB, unpacked 20.01 MB, UI 18.40 MB,
  core root gzip 594.2 KB. Temporary probe backend 2787 also stopped. Main
  server 2784 remains running; no commits, pushes, or releases performed.
- Current runbook: [Browser Apps](docs/apps.md) (was `examples/artipod-spa/execution-preview.md`).

### 2026-09-05 - single-branch workflow

Owner requested all phases remain on `main`. Removed per-phase branches and PR/merge prerequisites; retained sequential verification gates and worklogs. Historical references to the earlier branch/PR convention below describe past state, not current requirements. No branch, commit, or push was performed for this plan amendment.

### 2026-09-05 - owner-approved execution-admission amendment

- **Decision:** the owner requested updating the plan after selecting approval-before-execution, human/company attribution (with privately accountable actors), layer-level evidence, browser-local edits, and server acceptance/review before distribution. Sections 0-15 now reflect that direction. This is authorization to revise the plan, not evidence that signing or admission has been implemented.
- **Changed boundary:** approved same-origin applications are trusted code. Unknown external pods stay inert; local development requires explicit session authorization. The earlier requirement to isolate all running applications from the host is deferred rather than silently claimed satisfied.
- **Approval subject:** final immutable composition, executable dependencies, declared capabilities, audience, and execution mode. Layer signatures are evidence, not automatic composition approval. Artifact identity, author/publisher signatures, and execution approval remain distinct.
- **New work:** M0 admission/signature/local-development checks, M2 pending submission and role-enforced reviewer approval, negative recipient tests, offline validity policy, and accountability records. Signing implementation/identity integration remain open choices requiring recorded selection; production enrollment is out of scope.
- **Evidence preserved:** the historical M0 result below remains a no-go for that opaque-iframe design. It does not prohibit a newly tested trusted same-origin provider, does not pass the revised gate, and does not require repeating isolation experiments merely to satisfy superseded criteria. Baseline blockers must be rechecked, not assumed resolved.
- **Implementation status:** this amendment changes only the plan. No runtime code, approval service, signature, deployment, gate commit, or phase transition is produced by it. M1-M4 remain not started.

### 2026-09-05 - revised M0 baseline refresh

- **Status:** begun at the owner's request (`begin`); baseline blockers reproduced before any new implementation edit. No gate is earned, and M1-M4 remain unstarted. The second M0 task remains unchecked: signing implementation, test identities, pinned test roots, and offline freshness policy are not yet selected/provisioned.
- **Starting state:** `main`, revision `ab9765184e45c3a2af47dc2f83e6be171117d4bf`; Node `v24.20.0`, npm `11.19.0`, macOS. `git status --short` listed only untracked `examples/artipod-spa/{app/m0/,bin/,lib/m0/,m0-runtime-probe.md,public/}`, `git-plan.md`, and this plan. These existing files were preserved. After checks, the same status remained and `git diff --stat` was empty; no tracked implementation changes resulted.
- **Baseline commands/results:** each command ran independently so a failure did not skip subsequent checks. Logs are local at `/var/folders/n8/rxssgwbn241dk4twzmw811dc0000gp/T/artipod-m0-revised-baseline-koonWH/` (not committed).

| Command | Result | Log |
|---|---|---|
| `npm run lint` | Pass, exit 0 | `core-lint.log` |
| `npm run build` | Pass, exit 0; run before CLI tests | `core-build.log` |
| `npx tsc --noEmit` | Fail, exit 2: `src/oci/view-pull.test.ts:233`, TS2554 | `core-typecheck.log` |
| `npm run test` | Pass, 49 files / 531 tests | `core-test.log` |
| `npm --prefix examples/artipod-spa run lint` | Pass, no warnings/errors | `spa-lint.log` |
| `npm --prefix examples/artipod-spa run typecheck` | Fail, exit 2: duplicate nominal core types in `components/Workspace.tsx` | `spa-typecheck.log` |
| `npm --prefix examples/artipod-spa run test` | Pass, 4 files / 42 tests, including the historical probe tests | `spa-test.log` |
| `npm --prefix examples/artipod-spa run export:static` | Fail, exit 1: optimized Next build throws `RangeError: Invalid array length`; struct-minify/version assertions not reached | `spa-export.log` |

- **Blocker classification:** the core typecheck reports the existing `new OciStore(zfs, '/repo/.artipod-dest')` call passing two arguments to a one-argument constructor. Passing runtime tests do not resolve that static error. SPA typecheck reports `Sandbox`/`PodEvents` incompatibility between root `dist/` and the installed `node_modules/@artipod/core/dist/` at Workspace lines 267, 268, 279, 309, and 337; dependency-resolution cause and repair remain unverified. Export refreshed the copied core with its existing install workflow, prepared WASM assets, then Next `15.5.25` failed during optimization with only `at Array.push (<anonymous>)` in the stack. The export's root-inference warning is not established as its cause. No package upgrades, aliases, minification relaxations, or unrelated source repairs were applied.
- **Authority inspection:** targeted source search for attestation/Sigstore/cosign/DSSE/JOSE facilities found only the existing `src/manager/authority.ts` authority surface. Reading that module confirms it owns pod KEKs, leases, delegation certificates, offline grants, and CRLs through the existing JSON signing helpers. It is not an established artifact-attestation implementation and its keys will not be repurposed for execution approval. Maintained-format selection and independent test publisher/approver provisioning remain pending; no credentials were generated or read.
- **Next decision / stop:** obtain owner authorization to repair the pre-existing baseline blockers (core test constructor, SPA duplicate-core resolution, and export failure), or have them resolved separately, then rerun the baseline before continuing revised M0. Do not waive the phase checks or proceed to M1. D4 stays open; no new browser/runtime claim is made. No new server/browser session, trust-root change, signing dependency, deployment, publication, branch, commit, or push was performed. Weighbridge is not rerun for this documentation-only update; runtime/package changes must run it as required by section 12.

### 2026-09-05 - owner-authorized baseline repairs

- **Authorization:** owner answered `yes` to repairing the three pre-existing baseline blockers. This authorizes the scoped repairs below, not relaxed gates, publication, deployment, or a phase transition.
- **Core repair:** [src/oci/view-pull.test.ts](src/oci/view-pull.test.ts) now constructs the destination `OciStore` over a separate `bindContext` filesystem, following the existing manager tests. The ignored second constructor argument previously left source and destination using the same storage. Added assertions that the destination has neither the index blob nor the ref before sync. `npx vitest run src/oci/view-pull.test.ts && npx tsc --noEmit` passed (8 focused tests plus core typecheck).
- **SPA diagnosis:** `npm --prefix examples/artipod-spa run typecheck -- --incremental false --traceResolution` showed service imports resolving through `lib/node_modules/@artipod/core -> ../../../../..`, while components used the installed copy. Moving that link out of resolution made the non-incremental typecheck pass. Export recreated the link and still failed. A process-local `uncaughtExceptionMonitor` exposed the raw stack in Webpack's `FileSystemInfo._resolveContextTsh` / `processAsyncTree` symlink traversal, rather than the minifier. Diagnostic logs: `/tmp/artipod-m0-spa-resolution.log`, `/tmp/artipod-m0-raw-build.log`.
- **SPA repair:** [examples/artipod-spa/scripts/export-static.mjs](examples/artipod-spa/scripts/export-static.mjs) passes `ARTIPOD_NO_DEVLINK=1` only to its copied-core refresh install. Core's nested prepare/build otherwise runs `scripts/devlink.mjs` with the inherited npm prefix, creating an accidental SPA-local npm prefix and a recursive core link. The existing opt-out prevents that side effect without aliases, package upgrades, or weakening minification. Both the focused export and the final full baseline export passed the struct-minify and baked-version assertions.
- **Preserved local artifacts:** moved only the verified accidental `lib/node_modules/@artipod/core` and `bin/artipod` symlinks into `/var/folders/n8/rxssgwbn241dk4twzmw811dc0000gp/T/artipod-m0-prefix-backup-ITedrZ/` as `core-link` / `artipod-bin-link`; the copies recreated during diagnosis were preserved as `recreated-core-link` / `recreated-artipod-bin-link`. They retain their original relative target strings for restoration to their original paths. No application/pod data was removed. An initial guarded attempt failed before mutation on a trailing-slash mismatch; the next hit cross-filesystem `EXDEV`, so the successful backup used `mv`.
- **Final baseline:** all commands below exited 0. Logs are local at `/var/folders/n8/rxssgwbn241dk4twzmw811dc0000gp/T/artipod-m0-repaired-baseline-NcGH8e/`. The nested core link remained absent after the full export.

| Command | Result | Log |
|---|---|---|
| `npm run lint` | Pass | `core-lint.log` |
| `npm run build` | Pass, before CLI tests | `core-build.log` |
| `npx tsc --noEmit` | Pass | `core-typecheck.log` |
| `npm run test` | Pass, 49 files / 531 tests | `core-test.log` |
| `npm --prefix examples/artipod-spa run lint` | Pass | `spa-lint.log` |
| `npm --prefix examples/artipod-spa run typecheck -- --incremental false` | Pass | `spa-typecheck.log` |
| `npm --prefix examples/artipod-spa run test` | Pass, 4 files / 42 tests | `spa-test.log` |
| `npm --prefix examples/artipod-spa run export:static` | Pass, including struct-minify and baked-version assertions | `spa-export.log` |

- **Scope / next work:** the baseline blockers are resolved, superseding the prior stop condition. No runtime/package dependency or measured core-output change was made, so weighbridge was not rerun for these test/build-environment repairs. No UI behavior change or new browser proof is claimed. The second M0 task remains incomplete until attestation selection, test identities, pinned roots, and offline freshness policy are recorded; D4 and the M0 gate remain pending. No commit or push was performed.

### 2026-09-05 - M0 signing selection before implementation

- **Local hypothesis / discriminator:** browser-native JWS verification can enforce independent publisher/approver roles over immutable OCI digests without depending on the encryption authority. A focused test will sign with independent generated test keys, admit only the matching subject, and reject altered bytes, missing evidence, unknown keys, role substitution, wrong audience/mode, expiry, revocation, and stale signed status evidence. Browser integration remains a separate gate.
- **Implementation selection:** `jose` 6.2.12 provides maintained, dependency-free, browser/Node WebCrypto RFC 7515 JWS signing and verification. Use flattened JWS with ES256, signed `kid`/`typ`/`cty`, and host-pinned public JWKs. Claims bind an OCI manifest digest and reviewed execution requirements; serialized payload bytes are signed directly with no home-grown canonicalization. This is JWS artifact signing with application-specific claims, not an implementation of the Notary Project certificate profile or Sigstore bundles. Inspected current `@sigstore/sign` 5.0.0 / `@sigstore/verify` 4.1.2 (Node 22.22.2+ or 24.15.0+, not the repository's Node 20 floor); their Node-oriented verification is not selected for the browser-first slice. Sources: [jose](https://github.com/panva/jose), [JWS](https://www.rfc-editor.org/rfc/rfc7515).
- **Test identities:** reserve `m0-human-publisher`, `m0-organization-publisher`, and independent `m0-reviewer`, with separately generated ES256 key pairs. These are synthetic roles, not verified real people or organizations. Organization actor attribution belongs in private host test audit state, never in the distributed statement. Keep private keys in ephemeral test memory or a permission-restricted external host directory, never pods, browser bundles, logs, or model context. Host policy receives public JWK pins; artifact headers never select a remote key or supply a trust root. Do not reuse lease/KEK authority keys.
- **Test policy:** audience `artipod-m0-local`, mode `trusted-browser`, maximum approval lifetime one hour, signed revocation/status freshness five minutes (also capped by approval expiry). Status must bind the approval identifier; unknown/missing/expired status fails closed, whether online or offline. An offline verifier cannot learn new revocations within that bounded five-minute window. Development authorization is a separate future path, never fallback from failed release verification.
- **Scope:** initial code belongs in the existing SPA `lib/m0` proof area, not a new core API, provider dependency, public signing service, or production trust setup. D4 remains open. The second M0 task stays unchecked until actual test provisioning and verification evidence is recorded.

### 2026-09-05 - revised admission implementation and live evidence

- **Scope:** continued on `main`, no commit, push, production root, deployment or
  M1 work. D12/D13 are implemented as test policy; D4 remains a working candidate.
  Checkboxes remain unchanged until full evidence and an authorized commit.
- **Signing:** `lib/m0/admission.ts` uses pinned `jose` 6.2.12 ES256 flattened JWS.
  Synthetic human/organization publishers and independent reviewer have separately
  generated keys; only public JWK pins and signed statements leave the test process.
  Private keys are nonextractable. Claims bind final OCI manifest, descriptor,
  ordered layers/dependencies/capabilities, publisher evidence, audience/mode,
  approval ID and signed status. Approval max one hour, status freshness five minutes.
  No lease/KEK keys reused, no Sigstore/Notation interoperability claim.
- **Crypto compatibility:** ZenFS's partial typed-array base64 polyfills ignore
  base64url options. Node signing/verifying agreed on padded standard-base64 JWS
  that Chrome rejected. Pinned `core-js` 3.49.0 standard encode/decode polyfills and
  strict base64url assertions fix this; real Node-signed evidence verifies in Chrome.
- **Runtime:** deterministic one-layer OCI subject uses existing core tar/hash
  helpers. Verification and subsequent reads use copied immutable application bytes;
  case data is excluded and read separately. Explicit memory-only development
  authorization binds workspace paths and requirements. Changed capabilities require
  renewed authorization. Revocation/reload clears authorization and disposes managed
  resources. A regression reproduced an old grant timeout disposing a newer session;
  generation-scoped cleanup fixes it. General filesystem enumeration and coherent
  multiwriter snapshots are not implemented by this fixed-path fixture.
- **Live setup:** real encrypted serve on 2787, Next dev on 3603, proxy target
  `http://127.0.0.1:2787`; Chrome 148.0.7778.280 / Electron 42.10.0 / VS Code 1.136.1
  on macOS. Scratch backend store/authority:
  `/var/folders/n8/rxssgwbn241dk4twzmw811dc0000gp/T/artipod-m0-admission-XTrtxX/`.
  Real OPFS fixtures `/m0-spike/{application,subject}` remain plaintext synthetic
  data. An encrypted backend does not prove fixture encryption.
- **D4 candidate:** iframe uses `allow-scripts allow-same-origin`; admitted code
  shares ambient browser authority, not hostile-code confinement. Chrome supplies
  empty navigation client ID; worker accepts only iframe destination + resulting
  guest ID with a live admitted-session owner. The random session URL is a
  capability, not authenticated embedding-parent identity. Subsequent reads bind
  guest ID. Identified strangers and empty-ID top-level navigation are denied in tests.
- **Browser execution:** HTML, CSS, PNG (2x2), relative/dynamic modules, case JSON
  and eight WASM bytes returned 200 through SW and the actual frame reached ready.
  WASM was fetched, not instantiated. Edit without authorization denied; authorized
  edit rendered priority high/title Application edited. Modified release denied
  subject mismatch. Old/revoked URLs returned 403. Full host reload preserved edits
  but cleared development authorization; failed release produced no iframe.
  `/api/keys` returned 200 through the encrypted proxy.
- **Offline:** verified evidence cached only in page memory and reverified on use.
  Actual disconnection allowed cached release execution; advancing verifier time
  360001 ms denied expired evidence. Fresh-page missing-cache launch failed fetch.
  Initial missing-cache test accidentally seeded via Reset's auto-launch, corrected
  and replayed. Signed revocations are remembered in-session, not polled/persisted.
  UI now exposes identities, deadline, and cached-offline state; that final UI change
  still needs visual replay. Disconnected revocation latency remains bounded by status.
- **Debugger:** CDP scriptParsed exposed projected main/data/order scripts;
  setBreakpointByUrl paused actual main.js line 4 and evaluateOnCallFrame inspected
  subject title/priority/timeline. External map loading via DevTools bypasses SW and
  returned 404. Signed fixture now embeds an inline map; runtime metadata exposes
  it and decoded main.ts sourcesContent matches executed source. Visible Sources
  mapped breakpoint and post-edit debugger replay remain pending. Root-relative
  `/case/subject.json` is unsupported/CSP-blocked; relative case paths work.
- **Commands/results:** `npm --prefix examples/artipod-spa run test -- lib/m0`
  passes 5 files/63 tests. Worker `node --check` and editor diagnostics pass.
  `npm run lint && ARTIPOD_NO_DEVLINK=1 npm run build && npx tsc --noEmit && npm run test`
  passes, 49 files/531 core tests. SPA `run lint`, `run typecheck -- --incremental false`,
  `run test` all pass, 8 files/88 tests. `npm --prefix examples/artipod-spa run export:static`
  passes struct-minify/version assertions. First attempt hit ENOTEMPTY from concurrent
  Next dev writes to `.next`; stopped only this session's dev server and reran.
  Public fixture moved to scratch as `test-admission-verified.json`; export refuses
  local test roots. `ARTIPOD_NO_DEVLINK=1 npm run weighbridge` passes all limits
  after owner-approved npm install: pack 4.13 MB, index gzip 594.2 KB. This measures
  existing `dist-ui`, not newly exported `out`; refreshed packaged-UI measurement
  remains before a runtime package gate. No budgets relaxed.
- **Remaining M0:** mobile/light/dark check stalled in shared-browser navigation;
  no new visual pass claimed. Finish visible mapped Sources/edited-source replay,
  full forged-message/fallback/startup/worker entrypoint audit, offline-cache and
  revocation lifecycle regressions, refreshed packaged-UI footprint and final D4
  record. Private organizational audit and reusable layer evidence remain M2 work.
  No phase gate or M1 transition. Historical evidence below remains unchanged.

### Historical M0 - browser runtime go/no-go

- **Status:** historical first candidate **no-go**, 2026-09-05. The following observations describe the pre-amendment isolation experiment; revised M0 admission/runtime work is not yet verified. M0 is not complete and M1 has not started.
- **Baseline / revision:** `b298c04`; `git status --short` showed only this untracked plan. No branch or commit created; implementation remains an uncommitted experiment on main pending authorization of git operations.
- **Changes and decisions:** D4 remains open. First hypothesis: a narrowly scoped service worker can project live OPFS-backed files into a sandboxed opaque-origin iframe while retaining ordinary module/asset semantics. Discriminator: real Chrome requests for the document, module, and mounted JSON must reach the authorized projection; sandbox flags must not be relaxed to make them work. This hypothesis was falsified in the integrated browser. The fixture maps separate application and subject directories through a read-only projection broker; it does not yet implement semantic discovery or a new core mount API.
- **Verification:** `npm run lint` and `npm run build` passed. `npx tsc --noEmit` failed before edits: `src/oci/view-pull.test.ts:233`, TS2554 (two arguments passed to a one-argument constructor). `npm run test` separately passed, 49 files / 531 tests. SPA `npm --prefix examples/artipod-spa run lint`, `run typecheck`, and `run test` passed (3 files / 25 tests). `npm --prefix examples/artipod-spa run export:static` failed before edits with `RangeError: Invalid array length` during optimized build; struct-minify assertions were not reached. Logs: `/tmp/artipod-m0-core-baseline.log`, `/tmp/artipod-m0-spa-baseline.log` (local, not committed).
- **Post-edit checks:** `node --check examples/artipod-spa/public/m0/projection-sw.js` passed. `npm --prefix examples/artipod-spa run test -- lib/m0/probe.test.ts` passed, 17 tests. Full SPA lint and tests passed, 4 files / 42 tests. Editor diagnostics reported no errors in new TS/TSX/worker files. SPA typecheck after the baseline export's core-copy refresh reports duplicate nominal `Sandbox`/`PodEvents` types in existing `components/Workspace.tsx`; `run typecheck -- --incremental false` confirms it is not just an incremental cache issue. No unrelated source was changed to hide these errors.
- **Browser setup:** `open_browser_page` opened `http://localhost:3601/m0/probe`; Playwright ran against that shared page. VS Code 1.136.1 / Electron 42.10.0 / Chrome 148.0.7778.280 on macOS; Node v24.20.0. Host = Next dev on 3601, proxying to a real `artipod serve --encrypt --no-exec --no-ui` on 2786. Scratch backend store/authority = `/tmp/artipod-m0.8hs8zy/{store,authority}`. Browser fixtures = Artipod OPFS graph under `/m0-spike/{application,subject}`; no memory fallback accepted. The synthetic OPFS fixture itself is plaintext; an encrypted backend is not a claim of encrypted fixture storage.
- **Observed success:** host-side projected HTML, JS, dynamic module, CSS, source map, case JSON, 8 WASM bytes all return 200. PNG decodes as 2x2 (an initially bad fixture was repaired and replayed). PUT, ungranted paths, and encoded path escapes return 403. Saved priority `high` and edited application source survive full host reload. An old-session URL returns 403, a live URL 200, and the same URL after revoke 403. `/api/keys` through the dev proxy returns 200. These are host/broker checks, not guest execution.
- **Observed failure:** the iframe with `sandbox="allow-scripts"` navigates to the projected document but bypasses the worker (`fromServiceWorker: false`), receives Next's 404, and produces zero broker reads from guest loading. Fetching the identical document from the controlled host yields 200 and the expected CSP. The guest's ready signal never arrives. No application module executes, so guest relative/dynamic imports, source-map debugging, live application reload, and root-relative support are unproven. An HTTP source-map download does not establish a working Sources tab.
- **Isolation observations:** evaluation inside the opaque 404 frame throws `SecurityError` for parent DOM, parent `__m0`, localStorage, and OPFS access. These do not establish a complete guest security boundary: the failed navigation receives Next's fallback page, not the projection's CSP, and its dev scripts attempt network traffic. External-network denial, malicious-app behavior, and comprehensive browser compatibility are not passed.
- **UI verification:** light/mobile 390x844 and dark/desktop 1280x800 inspected with `screenshot_page`; no horizontal overflow. Fixed the foreground token after the first dark check; confirmed rgb(250,250,250) text on rgb(23,23,23). The visible 404 is the recorded experimental failure, not a successful viewer.
- **Deviations / blockers:** baseline core typecheck/export failures and post-refresh SPA duplicate-core types prevent a full gate. No new core API, package dependency, release, production deployment, or permission relaxation. Full gates/struct-minify/weighbridge were not claimed after the no-go. Stop before M1; obtain owner review of a new D4 candidate. A dedicated unprivileged preview origin is a candidate to investigate, not a proven solution; it must separately address navigation-based exfiltration, worker scope, mount grants, and credential separation.
- **Gate / PR:** no gate commit or PR; candidate rejected, not the overall Artipod concept. The standalone reproduction was retired on 2026-09-06; current workflow: [Browser Apps](docs/apps.md).

### M1 - semantic discovery and composition

- **Status:** not started; awaiting M0 gate.
- **Changes and decisions:** pending; finalize D3 here.
- **Verification:** pending.
- **Deviations / blockers:** none assessed yet.
- **Gate / PR:** pending.

### M2 - application-only distribution

- **Status:** not started; awaiting M1 gate.
- **Changes and decisions:** pending; record D6 snapshot/submit/review/approve/promote implementation, test roles/destination, signature and final composition digest, private audit mapping, and clean-environment setup.
- **Verification:** pending.
- **Deviations / blockers:** none assessed yet.
- **Gate / PR:** pending.

### M3 - agent-driven edits

- **Status:** not started; awaiting M2 gate and owner-confirmed integration.
- **Changes and decisions:** pending; record D7 integration approval and non-secret provider details.
- **Verification:** pending; separate deterministic tests from live model, development authorization, reviewer approval, and recipient execution evidence.
- **Deviations / blockers:** none assessed yet.
- **Gate / PR:** pending.

### M4 - multiple apps and documentation

- **Status:** not started; awaiting M3 gate.
- **Changes and decisions:** pending.
- **Verification:** pending; include complete demo replay and section 14 acceptance reconciliation.
- **Deviations / blockers:** none assessed yet.
- **Gate / PR:** pending.