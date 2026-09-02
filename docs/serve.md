# artipod serve

One command, a sync server and a registry you can embed:

```bash
npx artipod serve --publish ./my-notes
```

That prints one URL. The server hosts:

- the **native sync surface** at `/api/pods` (blobs + refs, digest-verified, merge-on-push),
- an **OCI registry relay** at `/api/oci/<host>/…` (GET-only, allowlisted upstreams),
- a **git smart-HTTP proxy** at `/api/git/<host>/…`,
- **exec sessions** at `/api/exec` (opt-out with `--no-exec`),
- a landing page at `/` (the full sync-demo UI arrives in serve plan S2),
- the **OCI Distribution API** at `/v2/` (pull works now — `docker pull localhost:2784/my-notes:latest`; push arrives S4).

> dockerd treats `127.0.0.1:<port>` as implicitly insecure; pulling from any
> other HTTP host needs that `host:port` in the daemon's
> `insecure-registries`. TLS is a reverse-proxy concern (see plan §5).

## Quickstart

```bash
artipod serve                          # serve ~/.artipod/store on http://127.0.0.1:2784
artipod serve --publish ./my-notes     # snapshot the folder as my-notes:latest; pushes write back
artipod serve --host 0.0.0.0           # LAN bind — a token is generated and required (V7)
artipod serve --only registry          # registry surface only
```

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--port <n>` | `2784` ("ARTI" on a keypad) | Listen port; `0` = OS-assigned |
| `--host <addr>` | `127.0.0.1` | Bind address |
| `--store <path>` | `~/.artipod/store` (env `ARTIPOD_STORE`) | The served OCI-layout store — a plain directory, skopeo-inspectable. Not the pods dir (`~/.artipod/pods`). |
| `--publish <dir>` | — | Repeatable. Snapshot the folder at boot as `<basename>:latest` (one layer per file) and materialize pushed heads back into it. Published dirs form the write-back roots allowlist (plus env `ARTIPOD_PUBLISH_ROOTS`), re-checked on every materialize. |
| `--token <t>` | open on localhost (env `ARTIPOD_SERVE_TOKEN`) | Require `Authorization: Bearer <t>` on every surface |
| `--only web\|registry` | both | Narrow the surfaces |
| `--cors <origin>` | deny | Repeatable exact-match origin allowlist for `/api/pods`, `/api/oci` (and later `/v2`). The shipped UI is same-origin and needs none of this. |
| `--oci-allow <host>` | deny | Repeatable upstream allowlist for the registry relay (env `ARTIPOD_OCI_ALLOWED_HOSTS`) |
| `--no-exec` | exec on | Disable the exec surface. Exec auth: env `EXEC_API_TOKEN`, falling back to the serve token. |
| `--open` | — | Open the printed URL in a browser |

## Tokens (V7)

Binding to localhost stays open by default. Binding anywhere else with no
token configured **generates one** (printed at startup, Jupyter-style) and
requires it on every surface. Static ro/rw tokens and `docker login`
(Basic) support arrive in serve plan S5.

## Ref-write semantics (V8)

Two write paths, two semantics — documented loudly on purpose:

- **`PUT /api/pods/refs`** (native): a pushed head that diverged from the
  current one **merges** via LWW `mergeHeads`; a stale push leaves the head
  alone. History stays a DAG through `org.artipod.parents`.
- **`PUT /v2/<name>/manifests/<tag>`** (distribution, arrives S4): plain
  **last-write-wins overwrite** — registries don't merge. The tag is still a
  plain ref, so prior heads stay reachable where the pusher recorded
  parents.

## Embedding

The CLI hosts a single Fetch handler — embedding it is one import and one
route:

```ts
import { createArtipodApp, serveApp } from '@artipod/core/server';
import { OciLayoutPodStore } from '@artipod/core/manager';

const app = createArtipodApp({ store });   // (req: Request) => Promise<Response>
// mount in Next.js catch-all, Hono, Bun.serve, Deno.serve — or:
const { url, close } = await serveApp(app, { port: 2784 });
```

The CLI and your app run the same object; behavior cannot drift.
