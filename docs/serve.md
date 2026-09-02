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
| `--lock <ref>` / `--unlock <ref>` | — | Repeatable. Tag immutability — see [Locked tags](#locked-tags). Persisted in `<store>/locks.json`. |
| `--seal-pattern <regex>` | `^[^_]` — **enforced by default** (env `ARTIPOD_SEAL_PATTERN`; `--no-seal` disables) | Tags matching the regex are **create-once**: the first push lands, every later move or delete is 403. The default seals every tag except `_`-prefixed open drafts. `--publish` folder refs are exempt (write-back is their point). See [Locked tags](#locked-tags) and [dossier.md](dossier.md). |
| `--only web\|registry` | both | Narrow the surfaces |
| `--cors <origin>` | deny | Repeatable exact-match origin allowlist for `/api/pods`, `/api/oci` (and later `/v2`). The shipped UI is same-origin and needs none of this. |
| `--oci-allow <host>` | deny | Repeatable upstream allowlist for the registry relay (env `ARTIPOD_OCI_ALLOWED_HOSTS`) |
| `--no-exec` | exec on | Disable the exec surface. Exec auth: env `EXEC_API_TOKEN`, falling back to the serve token. |
| `--open` | — | Open the printed URL in a browser |

## The UI (S2, local-first)

`/` serves the sync-demo UI when one resolves; resolution never touches the
network:

1. `--no-ui` → headless landing, no resolution.
2. `ARTIPOD_UI_DIR=<dir>` → serve that static build directly (dev loop).
3. The `artipod-ui:latest` ref in the store (`ARTIPOD_UI_REF` overrides) →
   materialized once to `~/.artipod/ui/<digest>/` and served from there.
4. **The bundled UI**: the npm package ships the static build at
   `<pkg>/dist-ui`, so `npx artipod serve` shows the full UI out of the box,
   offline — core and UI are built and versioned together, so they cannot
   skew. (The release workflow runs `npm run build:ui` before publishing.)
5. Nothing found (a dev checkout without `dist-ui`) → the headless landing.
   Never an error.

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

## Locked tags

A tag is a mutable pointer; sometimes you want it to stop being one — the
registry-world precedent is Harbor/ECR *tag immutability*. Locking a ref
freezes its head:

```bash
artipod serve                           # DEFAULT: tags not starting with _ seal on first push
artipod serve --no-seal                 # classic mutable-tag registry
artipod serve --seal-pattern '^\d{4}-\d{2}-\d{2}'   # narrower: only date tags seal
artipod serve --lock me/play:1          # explicit per-ref lock (persisted in <store>/locks.json)
artipod serve --unlock me/play:1        # release
```

Semantics (enforced server-side, regardless of token):

| operation on a locked ref | result |
|---|---|
| read / pull (either surface) | unchanged |
| `PUT /api/pods/refs` head move | `403` |
| `PUT /v2/…/manifests/<tag>` | `403 DENIED` |
| `DELETE /v2/…/manifests/<tag>` or `DELETE /api/pods/refs?name=` | `403` — sealed tags cannot vanish |
| `PUT /v2/…/manifests/<digest>` | allowed — storing bytes moves no tag |
| open in **ro** or **cow** mode | unchanged — cow forks are local |
| **rw** / push-back | refused; fork with cow and `publish` under a new ref |

`--seal-pattern` locks by **shape** instead of by list, and the default
(`^[^_]`) makes the [dossier convention](dossier.md) the contract: a tag
either starts with `_` (an open draft — mutable, deletable, collaborative) or
it seals on the push that creates it. `--publish` folder refs are exempt —
they are living mirrors whose point is write-back. `--no-seal` restores
classic registry behavior. Unmatched tags stay mutable *and deletable*
(`DELETE` retires them; blobs and history stay).

The refs API marks locked entries (`"locked": true`), so UIs can drop the
rw affordance up front — the shipped demo shows a `locked` badge and offers
only cow/ro. Locking composes with the digest display: a locked
`me/play:1 @a460ab57` is a name that provably cannot change out from under
you. Embedders pass their own policy: `createArtipodApp({ isLocked })`.

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
