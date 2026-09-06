# Executable Pod Preview

The M0 browser runtime is an option in the main artipod catalog. It uses the
same `artipod serve` origin as the workbench. No separate Next server or
`/m0/probe` page is required.

## Run a Local App

Place an `artipod.json` descriptor and saved application assets in a pod root:

```json
{
  "apiVersion": "artipod.io/v1",
  "kind": "SPAPod",
  "metadata": { "name": "My application" },
  "spec": { "entrypoint": "index.html" }
}
```

1. Return to the catalog and choose **Run** beside the executable pod.
2. Choose **Run in development**, review the same-origin trust warning, and
   explicitly authorize this workspace. Discovery and URL parameters never
   authorize execution. Server-ref Run opens a local copy-on-write workspace.
3. Use **Reload saved application** to capture saved edits, **Stop** to suspend a
   cooperating app in place (**Resume** continues it), **Close** to revoke the
   session and remove the frame, or the expand icon for an app-focused view.
   Collapse returns to the same workspace and running app. Returning to the
   catalog closes the app.

The HTML entrypoint is relative to the pod root. `/app/index.html` is also
accepted, with `/app` denoting the projection prefix, not a physical subfolder.
Use relative asset/module URLs. Captures exclude `.artipod`, `.git`,
`node_modules`, and `case` directories; symlinks and path escapes are rejected.
Limits: 128 files, 1 MiB per file, 8 MiB total, depth 12, 256 scanned entries.
Saving does not mutate an already admitted snapshot. Changed requirements or
file lists require a new development confirmation. Authorization is memory-only
and expires after at most one hour or when stopped/closed.

## Lifecycle Sample

The durable [sample pod](m0-preview/artipod.json) lives in `m0-preview/`.
Its plain HTML and JavaScript require no build step. Import the directory into
a new pod (for example, from the repository root, `node dist/cli.js import
examples/artipod-spa/m0-preview samples/lifecycle:_1`) or copy its files into
a new local workspace, then use the catalog's Run action. Choose a new ref
when importing if that example ref already contains edits you want to retain.

On load, the app starts a one-second interval. Each tick fills and retains a
16 KiB buffer, up to 8 MiB; the elapsed timer continues after the allocation cap.
The counter, buffers, and timer belong to the iframe instance, not saved files.
Switching workspace views preserves them. Reload replaces the instance and
starts fresh. Close removes the iframe and the workbench's telemetry. Memory
reclamation is controlled by the browser's garbage collector, not guaranteed
to happen immediately on Close.

**Stop** is cooperative. The workbench sends a versioned
`artipod:runtime-lifecycle/v1` request to the current iframe and reports the
app as suspended only after the app acknowledges. The sample then clears its
interval, disables the counter, keeps its buffers, and freezes the elapsed clock;
both displays hold the final values. Resume continues from them without counting
the suspended time or catching up missed allocations. Browsers offer no portable
way to freeze arbitrary iframe JavaScript, so apps that never answer the
readiness query leave Stop disabled, and an unanswered request is shown as an
error rather than a false suspension. Suspension never extends approval expiry;
expiry, Close, and leaving the workspace still tear the app down.

Both the app and workbench show **App-retained memory**: the sum of the sample's
retained buffer lengths. This is not total heap, DOM memory, or a per-process
measurement. The workbench labels it **reported**, accepts only versioned
`artipod:runtime-telemetry/v1` messages from the current iframe and host origin,
validates numeric bounds, and updates at most once per second. Reports are
informational and never grant authority. Other apps need not implement them;
no report means no metrics display, not zero memory usage.

## Approved Releases

**Run approved** loads host-owned `/execution-policy.json` and
`/execution-approvals/<snapshot-sha256-hex>.json`, then verifies independent
publisher/reviewer ES256 JWS statements against the captured composition.
These are POC admission statements, not production signing infrastructure.
The snapshot digest is a deterministic application-only OCI composition, not
necessarily the enclosing pod's registry manifest digest.

Policy format follows `AdmissionPolicy` in `lib/m0/admission.ts`, omitting
`clock` and `revokedApprovalIds`; evidence follows `ReleaseEvidence`. Private
keys never belong in these files. Provision public host configuration separately
from the distributable UI; export refuses local configuration under `public/`.
The default server has no such policy and approved launch fails closed with an
explicit unavailable message. It never falls back to development automatically.
Approval, status freshness, and publisher validity all bound the session TTL.

## Trust and Current Limits

Admitted applications are **trusted same-origin code** with ambient browser
authority over the workbench and other pods. The iframe, CSP, read-only
projection, and random URLs are not hostile-code isolation. Stop revokes the
projection and removes the frame; it cannot undo actions already taken by an app.

Declared `/case` mounts currently block launch until explicit compatible mount
selection is implemented; no synthetic case is injected. External executable
dependencies are unsupported. Catalog discovery is bounded and inert: large or
unavailable OCI layers may not show Run, and local-only OCI forks are not yet
fully classified outside an opened workspace. The workspace rechecks its actual
descriptor and bytes before any launch.

The integrated approved launcher requires online host policy/evidence retrieval;
offline approval reuse and remembered revocation from the old probe have not yet
been ported. Its status describes admission, not application-defined readiness.
Full M0 acceptance, including integrated signed browser/offline/source-map replay
and explicit CasePod data resolution, remains pending in the root plan. A live
JavaScript breakpoint and variable inspection passed on the catalog runtime.

## Verification

```sh
npm --prefix examples/artipod-spa run lint
npm --prefix examples/artipod-spa run typecheck -- --incremental false
npm --prefix examples/artipod-spa run test
npm --prefix examples/artipod-spa run export:static
```

Stop any Next dev server using this app before export. Serve the export through
`artipod serve`, using its bundled UI or `ARTIPOD_UI_DIR`; do not introduce a
second UI origin. The standalone opaque-frame and admission probes were retired
after catalog-path verification. Their findings remain historical evidence in
[the model execution plan](../../model-exec-poc.md).