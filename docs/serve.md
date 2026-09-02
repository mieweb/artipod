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
- a landing page at `/` — or the **full sync-demo UI** when one resolves
  (see "The UI" below),
- the **OCI Distribution API** at `/v2/` — pull *and* push: `docker pull`,
  `docker push`, upload sessions (chunked + monolithic), cross-repo mount,
  the referrers API (in-memory index), tags/list + `_catalog`.

> dockerd treats `127.0.0.1:<port>` as implicitly insecure; pulling from any
> other HTTP host needs that `host:port` in the daemon's
> `insecure-registries`. TLS is a reverse-proxy concern (see plan §5).
>
> Conformance: the official distribution-spec suite runs in CI (pull, push,
> content discovery) and gates on every non-sha512 test. sha512 digests are
> **not supported** (the store is sha256-addressed; the spec says SHOULD) —
> docker/crane/skopeo all push sha256. Content management (deletes) is not
> implemented.

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

## The UI (S2, local-first)

`/` serves the sync-demo UI when one resolves; resolution never touches the
network if you have a local copy:

1. `--no-ui` → headless landing, no resolution.
2. `ARTIPOD_UI_DIR=<dir>` → serve that static build directly (dev loop).
3. The `artipod-ui:latest` ref in the store (`ARTIPOD_UI_REF` overrides) →
   materialized once to `~/.artipod/ui/<digest>/` and served from there.
4. The digest-pinned remote artifact (`ghcr.io/mieweb/artipod-ui`) — only as
   a cold-start fallback, and dormant until a release pins a digest.
5. Nothing found → the headless landing. Never an error.

Build it locally:

```bash
cd examples/artipod-sync && npm run export:static   # → out/
artipod import out artipod-ui:latest                # into ~/.artipod/store
artipod serve                                       # full UI at /
```

## Tokens (V7/S5)

Binding to localhost stays open by default. Binding anywhere else with no
token configured **generates one** (printed at startup, Jupyter-style) and
requires it on every surface. Tokens are accepted as `Bearer <t>` or
Basic (`docker login`: any username, the token as password).

| surface | no token configured | ro token | rw token |
|---|---|---|---|
| native read (`GET /api/pods/…`) | open | 200 | 200 |
| native write (`PUT /api/pods/…`) | open | 403 | 201 |
| `/v2` pull | open | 200 | 200 |
| `/v2` push | open | 403 | 202/201 |
| exec (`POST /api/exec`) | open¹ | 403 | 200 |
| relay / git proxy / landing | open | 200 | 200 |

Unknown or missing tokens get `401` + `WWW-Authenticate: Basic
realm="artipod"`. ¹ exec can carry its own extra gate via `EXEC_API_TOKEN`.

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
