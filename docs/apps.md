# Browser Apps (`@artipod/core/apps`)

Run SPAPod applications from a pod, in the browser, on your own site. The
layer decides *whether* code may run (signed release evidence or an explicit
development authorization), projects the admitted bytes through a service
worker, and gives you a process table so running apps show up in `ps` and
answer `kill`. The artipod workbench (`examples/artipod-spa`) is the reference
consumer; nothing here depends on it.

## Use It in Your Own Site

```sh
npm install @artipod/core
```

1. Serve the worker from your site root. It is shipped as a dist asset; copy
   `node_modules/@artipod/core/dist/apps/runtime-sw.js` to
   `/artipod-runtime-sw.js` at build time (the workbench does this in its
   asset prebuild). The worker registers with scope `/` but intercepts only
   `/_artipod/run/…`; every grant is memory-only and bound to the page that
   made it. Return 404 for that prefix from your static server so a page
   without a worker never serves anything there.
2. Create a process table for the session and a runtime over the pod's files:

   ```ts
   import { createBrowserRuntime } from '@artipod/core/apps';
   import { ProcessTable, registerProcessTable } from '@artipod/core/proc';

   const processes = new ProcessTable('my-session');
   registerProcessTable(processes);            // /proc/<pid>/status in shells
   const runtime = createBrowserRuntime({
     read: (path) => pod.zfs.promises.readFile(path),
     list: (path) => pod.zfs.promises.readdir(path),
     stat: (path) => pod.zfs.promises.lstat(path),
   }, '/work/my-app', { processes, detail: { pod: 'my-app' } });
   ```

   Pass the same table to `createZenFsPod({ processes })` (or
   `createSandbox({ processes })`) and every shell gets `ps` / `kill` plus its
   own `shell` row.
3. Render `runtime.store` however you like (`getState`/`subscribe`; the shape
   is zustand-compatible). `launch('development', true)` after your own
   explicit confirmation, or `launch('release')` against host-pinned policy.
   Mount `snapshot.url` in an iframe. For Stop/Resume, run
   `controlRuntimeLifecycle` over the iframe and hand it to
   `runtime.attach({ suspend, resume })` so `kill -STOP` reaches the app;
   forward its reports with `runtime.report(...)`.
4. `runtime.stop()` revokes the session; `processes.dispose()` on teardown
   cascades KILL to every row.

## Run a Local App in the Workbench

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

## Processes: `ps`, `kill`, `/proc/<pid>`

A pod session is a PID namespace. pid 1 is the session; the terminal shell,
each running app and each background task is a row. Visibility is downward
only: a shell sees its session, never another tab or the server.

```text
$ ps
PID PPID KIND  STATE     TIME NAME
  1    0 init  running   12s  samples/lifecycle:_3:cow
  2    1 shell idle      12s  bash
  3    1 task  idle      12s  [sync:push]
  4    1 app   running   4s   Lifecycle sample
$ kill -STOP 4      # cooperative suspend — same as the Stop button
$ kill -CONT 4      # resume
$ kill 4            # TERM/KILL: close and revoke the projection
$ cat /proc/4/status
```

`ps -l` adds kind-specific detail (mode, digest, url, reported telemetry).
Signals are honest: a row that does not handle one answers `Operation not
supported` — an app that never implemented the lifecycle protocol cannot be
frozen, and `ps` will keep saying `running`. `artipod ps` remains the detailed
view of scheduler tasks.

## Inventory: `images`, `lsblk`, `mount`

Processes are what runs; inventory is what exists. Both consoles (the
catalog's root console and every workspace shell) read the same rows the
catalog page renders:

```text
$ images                      # "On this server" — also: artipod images
REPOSITORY         TAG  DIGEST    ENCRYPTION LOCKED STATUS
samples/lifecycle  _3   e92582b6  plaintext  -      forked
doug               _1   23eb8c12  encrypted  -      update available
$ lsblk                       # "On this machine" — also: artipod lsblk
NAME                  TYPE   MODE  ENCRYPTION  STATE        MOUNTPOINT
ba772299              blank  rw    plaintext   has files
samples/lifecycle:_3  fork   cow   encrypted   unpublished  /open/samples_lifecycle__3
$ mount                       # lsblk -m: only what some tab has open right now
$ cat /proc/workspaces/samples_lifecycle__3/status
$ cat /proc/images/doug__1/status
```

A workspace is a block device: it exists in OPFS whether or not a tab has it
open, and `MOUNTPOINT` is set only while one does (each open tab holds a Web
Lock, so this is observed, not guessed). The catalog console's `artipod`
supports `images`, `lsblk` and `ps` only; pod verbs need an open workspace.
Consumers supply the rows through `InventoryProviders` on
`createSandbox({ inventory })` / `createZenFsPod({ inventory })` and
`registerProcProvider(makeInventoryProvider(inventory))`.

### Looking inside an image: `-v`, `-vv`, `--json`, `/proc`

```text
$ images -v ghcr.io/mieweb/artipod-examples/case:latest   # (-v <ref> implies -vv)
ghcr.io/mieweb/artipod-examples/case:latest  @c8209ca3  plaintext
    local   /.artipod/oci/blobs/sha256/c8209ca3…   (not pulled — open the workspace to fetch it)
    remote  http://127.0.0.1:2784/api/pods/blobs/sha256:c8209ca3…
    parents f96e225b   (previous head — the tag's history)
    layers  13 file layers · 826.2 kB · 0 local ● 13 lazy ☁︎ · by examples-builder
    │   bottom → top; later layers win
    ├─  1 ☁︎ f3aa878a     587 B  /DISCLAIMER.md                 2026-01-12 15:15  examples-builder
    …
    └─ 13 ☁︎ 688dd481     561 B  /visits/2026-01-21/report.mdy  2026-01-21 20:20  examples-builder
```

- `images -v` is summary-first: where the bytes live, the parents, one layer
  line with hydration counts, and **what changed since the parent** (layers in
  this head that the parent did not carry) — the `git show --stat` of an image.
- `images -vv` (or `-v <ref>`) prints the whole stack; `●` = blob in this
  browser's store, `☁︎` = lazy (not fetched yet).
- `--json` on `images`, `lsblk`, `mount`, `ps` emits JSON Lines shaped like
  the exported `ImageRow` / `VolumeRow` / `ProcessInfo`; `images -v <ref> --json`
  emits one `ImageDetail`.
- `/proc/images/<slug>/manifest.json` is the raw OCI manifest (present only
  when it is readable here), so the real artifact is one `jq` away:

  ```sh
  jq -r '.layers[].annotations["org.artipod.path"]' /proc/images/doug__1/manifest.json
  jq -r '.annotations["org.artipod.parents"]'        /proc/images/doug__1/manifest.json
  ```

A note on `ENCRYPTION` vs `alias`: the column is the **server's** state. A
tab that holds a key lease encrypts everything it writes to its own store, so
a plaintext server image you pulled shows an `alias` line locally — that is
your copy being ciphertext, not the server's.

### Glossary (vs OCI / Docker)

| Term | Means here | OCI / Docker |
|---|---|---|
| image | manifest + config + layers | same |
| ref | `repository:tag` | same |
| file layer | an ordinary OCI layer that artipod's publish/import path emits **per file**, annotated with path, mtime, actor | a layer; Docker just happens to make one per build step |
| lazy | a layer whose blob is not fetched yet (hydration state) | no equivalent; never means "per-file" |
| parents | `org.artipod.parents`: the previous head(s) of the tag — the image's history | no equivalent (`docker history` shows layers, not lineage) |
| workspace / fork | a copy-on-write upper over a basis image | container |

Docker's overlay2 cannot run a >128-layer image as a rootfs; artipod volume
images are not meant to be run that way.

## Lifecycle Sample

The durable [sample pod](../examples/lifecycle-app/artipod.json) lives in
`examples/lifecycle-app/`. Its plain HTML and JavaScript require no build
step. Import the directory into a new pod (for example, from the repository
root, `node dist/cli.js import examples/lifecycle-app samples/lifecycle:_1`)
or copy its files into a new local workspace, then use the catalog's Run
action. Choose a new ref
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

Policy format follows `AdmissionPolicy` in `src/apps/admission.ts`, omitting
`clock` and `revokedApprovalIds`; evidence follows `ReleaseEvidence`. Private
keys never belong in these files. Provision public host configuration separately
from the distributable UI; export refuses local configuration under `public/`.
The default server has no such policy and approved launch fails closed with an
explicit unavailable message. It never falls back to development automatically.
Approval, status freshness, and publisher validity all bound the session TTL.

## Trust and Current Limits

Admitted applications are **trusted same-origin code** with ambient browser
authority over the workbench and other pods. The iframe, CSP, read-only
projection, and random URLs are not hostile-code isolation. Close revokes the
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
npm run lint && npm run build && npx tsc --noEmit && npm run test   # core, incl. src/apps + src/proc
npm --prefix examples/artipod-spa run lint
npm --prefix examples/artipod-spa run typecheck -- --incremental false
npm --prefix examples/artipod-spa run test
npm --prefix examples/artipod-spa run export:static
```

Stop any Next dev server using this app before export. Serve the export through
`artipod serve`, using its bundled UI or `ARTIPOD_UI_DIR`; do not introduce a
second UI origin. The standalone opaque-frame and admission probes were retired
after catalog-path verification. Their findings remain historical evidence in
[the model execution plan](../model-exec-poc.md).