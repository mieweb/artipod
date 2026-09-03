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
| `--encrypt` | off | Broker mode: the store writes chunked-AEAD ciphertext at rest and `/api/keys` issues key leases. See [Encrypted pods and key leases](#encrypted-pods-and-key-leases-s55). |
| `--key-ttl <dur>` | `1h` | Lease TTL cap for `/api/keys` logins — `<n>(ms\|s\|m\|h\|d)`. Issued TTL = min(requested, cap). |
| `--authority <dir>` | `~/.artipod/authority` | Key authority home: signing key + raw pod KEKs, dir `0700`, files `0600`. Created on first `--encrypt`. **Guard its backups.** |
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

Build it locally (dev checkout — npm installs already carry it):

```bash
npm run build:ui        # exports the demo → dist-ui/, served at /
artipod serve
```

The `artipod-ui:latest` store ref remains a deliberate override (update a
running server's UI by pushing a new one — no reinstall), but it is
infrastructure: the demo catalog hides it.

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

## Encrypted pods and key leases (S5.5)

Two ways to serve encrypted content — pick per trust model:

| | **blind host** (default — zero flags) | **broker** (`--encrypt`) |
|---|---|---|
| what the server holds | opaque ciphertext blobs + an encrypted envelope ref | ciphertext at rest **plus the KEK** |
| can the server read the data? | **no — ever** | **yes** — stated honestly: a broker can decrypt what it brokers (write-back materializes plaintext anyway) |
| how keys move | out-of-band (you distribute them) | `POST /api/keys/login` → signed lease + KEK |
| client sync | `pushEncryptedRef` / `pullEncryptedRef` (ciphertext digests only) | ordinary sync with an `X-Artipod-Lease` header; wire is plaintext (put TLS in front off-localhost) |
| `/v2` (docker) | works for the ciphertext blobs it can address | **off (403)** — the distribution API cannot carry leases, and serving decrypted blobs to any token holder would bypass them |
| code needed | none — an encrypted ref is just blobs + a ref to this server | `--encrypt` |

**Broker mode** (`artipod serve --publish <dir> --encrypt`):

- First boot creates the authority (`~/.artipod/authority`, `0700`): an ECDSA
  signing key (`authority.json`) and one KEK per served store (`keks.json`),
  keyed by the store's `store-id.json`. **Serve makes the key if one is not
  there** — no ceremony.
- Every blob written after `--encrypt` (including the boot `--publish`
  snapshot) lands as chunked-AEAD ciphertext with a `.alias` digest twin
  ([encryption.md](encryption.md#at-rest-format)). Blobs already on disk stay
  as they were — use a fresh store for full coverage.
- `POST /api/keys/login` (JSON: `{principal?, podIds?, ttlMs?}`) returns a
  signed lease + base64 KEKs. It authenticates through the S5 token hook: an
  **ro token gets a read-only lease**; no token needed on an open localhost
  serve. `GET /api/keys` returns metadata only (never key material); without
  `--encrypt` the route 404s.
- Gated requests carry `X-Artipod-Lease: <base64 lease JSON>`. Blob
  reads/writes and ref **writes** require a live lease covering the store's
  pod with a matching permission; ref **reads** stay open (pointers are the
  same metadata a blind host serves). Missing/expired → `401` + re-login
  hint; wrong scope/permission → `403`.
- Browser side: the demo logs in **device-wrapped by default** — the tab
  holds a non-extractable ECDH device keypair (persisted via structured
  clone in IndexedDB), sends `devicePublicKey`, and the KEK arrives
  ECDH-wrapped (`unwrapLoginResult` → a **non-extractable** AES key: raw key
  bytes never exist in page-visible JS on either end). `PodLocker.adoptLease`
  puts it in the tab's **memory-only keyring**, and both the pod's local
  store **and its working tree** encrypt at rest with it — workspace uppers
  are opaque encrypted block stores (`encryptedStoreMount` from
  `@artipod/core/sandbox`): the backing medium shows numbered ciphertext
  blocks under a hashed dir name, no filenames, no tree shape. Without a
  device key, `decodeLoginResult` + `adoptLogin` handle the raw-base64 wire.

**What the TTL means (V10 — no overpromising).** Client keyrings hold
non-extractable keys in memory only: closing the tab loses the key
immediately, and at expiry the keyring evicts it (`PodLockedError`;
re-login restores — no data rewrite). Enforcement is **layered**:
cooperative client eviction, plus the server's hard powers — refusing lease
re-issue and refusing further ciphertext after expiry. The TTL bounds an
open session; it is **not** revocation of an already-leaked key. That is
rotation/rewrap, a documented future ([encryption.md](encryption.md)).

A keyless serve of the *same* store stays useful as a blind host: refs list
fine, ciphertext-addressed blobs sync byte-exact, and plaintext-addressed
reads answer `423 Locked` instead of leaking. Binding a key-issuing serve to
anything but localhost is ask-first territory — the authority dir holds raw
KEK material.

## Embedding

The CLI hosts a single Fetch handler — embedding it is one import and one
route. Shared setup (node):

```ts
import { nodePodFs } from '@artipod/core';
import { OciLayoutPodStore } from '@artipod/core/manager';
import { createArtipodApp, toNodeHandler } from '@artipod/core/server';

const store = new OciLayoutPodStore(nodePodFs(), './my-store');
await store.init();
const artipod = createArtipodApp({ store }); // (req: Request) => Promise<Response>
```

Express (or anything req/res-shaped on node:http):

```ts
app.use(toNodeHandler(artipod)); // mount at root — see caveat below
```

Hono — or any fetch-native host (Bun.serve, Deno.serve):

```ts
app.all('*', (c) => artipod(c.req.raw));
```

Next.js App Router — `app/api/[...path]/route.ts` (and
`app/v2/[[...path]]/route.ts` if you want the registry surface):

```ts
const h = (req: Request) => artipod(req);
export { h as GET, h as HEAD, h as POST, h as PUT, h as DELETE, h as OPTIONS };
```

Standalone, no framework:

```ts
import { serveApp } from '@artipod/core/server';
const { url, close } = await serveApp(artipod, { port: 2784 });
```

The CLI and your app run the same object; behavior cannot drift. Caveats:

- `createArtipodApp` routes on the **root** pathname (`/api/...`, `/v2/...`);
  mounting under a prefix is not supported — mount at `/`.
- Fastify parses request bodies before handlers run; either run `serveApp`
  beside it or register `toNodeHandler` via `@fastify/middie`.
