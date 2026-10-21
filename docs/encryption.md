# Encryption, keys, and offline authority

> **Status: ✅ implemented** (normative) in plan Phases 4 (formats) and 6.5 (keyring/leases/grants) — see `@artipod/core/oci` (chunked-AEAD cipher) and `@artipod/core/manager` (keyring, authority, grants, locker). Builds on the envelope-encryption discussion in [horner/artipod-sync#1](https://github.com/horner/artipod-sync/issues/1).

**The principle everything follows from:** disk only ever holds *ciphertext + wrapped keys*; usable keys exist only in a memory keyring, on a lease with a TTL. "Access expires" is not something done to the data — it is the key evaporating. Login (or a grant, or a delegated authority) restores the key, never rewrites the data.

## Managed local storage boundary

`@artipod/core/storage` owns protected local persistence through a
`StorageSession`. The SPA opens that session before mounting workspaces or
reading its registry; other browser and Node hosts use the same lifecycle.
The session's entire logical filesystem is an `encryptedStoreMount`:
contents, filenames, directory records, link targets, scratch files, workspace
names and local OCI/snapshot indexes are encrypted **before the first protected
backing write**. This applies to OPFS, IndexedDB and the native directory
adapter. Logical JSON metadata is ordinary JSON inside the protected filesystem;
it is encrypted together with file contents before reaching the backing store.

For the filesystem, only a versioned bootstrap (format, cipher, required-encryption
flag, backend, opaque generation and migration phase) is outside encryption. The
key service separately retains public broker/device metadata and device-wrapped
grants; these records contain no workspace names or file paths. Backing blocks
have numeric IDs beneath a random generation. Public model/runtime downloads
remain in a separate cache. See [on-disk-layout.md](on-disk-layout.md#the-browsers-disk-spa)
for the exact layout and legacy migration protocol.

A managed session defaults to the `protected` policy and requires an encryption
key for persistence. `memory` is an explicit volatile choice; `plaintext` is an
explicit caller-managed choice. The SPA's broker-based policy offers visibly
labeled memory-only work only when the server definitively reports no broker
and no saved vault requires encryption. An unknown or failed broker probe does
not authorize plaintext persistence. A known encrypted vault cannot be opened or relabeled as plaintext without its
key. Choosing `memory` starts a separate volatile root; it does not decrypt or
downgrade saved ciphertext.

One managed root may be active in a JavaScript realm because ZenFS has a shared
root. Close that session before opening another; multiple pods can share its
live storage context. A browser vault also holds an exclusive writer lock
across tabs. Lease expiry denies even cached filesystem reads; key replacement must
authenticate existing ciphertext before access resumes. Flush failures propagate
to saves and shell operations instead of being reported as durable success.
Previously decrypted application memory cannot be retroactively revoked.
The SPA retains unsaved editor drafts in this tab's RAM and restores them after
authenticated unlock; other hosts must retain their own drafts if they want the
same behavior. Those drafts are not written to browser storage until saved.
Reloading or closing the tab discards those unsaved drafts.
If lease loss leaves a failed persistence queue, authenticated recovery drains
and disposes the old sessions, closes the failed mount and reopens the saved
generation in the same page. The recovery warning identifies potentially unsaved
changes; it does not turn failed writes into durable success. RAM editor drafts
remain available for review and an explicit save.
This encryption boundary does not make ordinary ZenFS multi-block mutations
crash-atomic: the existing transaction rollback defect under backing failures
remains, so a failed operation can require recovery. Migration uses its own
verified generation protocol and preserves original sources until commit.

Reset stops key renewal and new filesystem writes, drains
accepted operations, and retains writer ownership until private storage deletion
finishes. An expired key or failed final flush is reported as a warning while
the confirmed erase continues. A failed erase preserves the encryption-required
bootstrap until the remaining backing stores have been removed.

A present malformed vault bootstrap is an error, including JSON null and other
primitive values. Only a definitively absent control record permits creation;
a corrupt record never authorizes replacing the saved generation with an empty one.

The SPA registry stages updates inside the encrypted root and retains a previous
complete registry while installing the replacement. Recovery uses that fallback
only when the primary name is absent; malformed or inaccessible primary JSON
still fails visibly. Failed writes are observed independently of the broker lease
so saved storage can be recovered without discarding tab-only editor drafts.

The managed vault currently encrypts its blocks directly with the supplied key
(the leased broker KEK in the SPA); it does not introduce independent per-layer
or per-generation DEKs. Browser history, git author preferences and optional
remembered credentials remain outside the workspace filesystem vault.

### Core lifecycle and compatibility

`KeysService` owns broker probes, ECDH login, device-wrapped offline sessions,
renewal, release and forced-offline preferences in core. Its `getSnapshot()`,
`getSettingsSnapshot()` and `subscribe()` API exposes serializable metadata;
CryptoKeys and signed lease documents stay in the service. The SPA's service is
a thin bridge from these snapshots into zustand. Fetch and key-value/mirror
adapters are injected, and importing the core module requires no browser globals.
`TaskScheduler` supplies the same named renewal task used by `artipod ps`.

Install only one `KeysService` fetch patch per JavaScript realm and reuse that
custody service across storage sessions. `install()` replaces global fetch;
creating additional installed services would compose their fetch patches.
Headless consumers that only need key custody can call `login(principal)`
without `install()`, leaving global fetch unchanged; the host then owns any
subsequent re-login scheduling.

Create a session with `createStorageSession(options)`, then call `open()`.
The session owns the configured filesystem, `flush()`, protected upper
projections, `registerTeardown()`, authenticated `recover()` and `reset()`.
Pass the `StorageSessionInfo` returned by `open()` as the `storage` option to
`createZenFsPod`, `OciStore` or `SnapshotManager`; the
context binds protection to the owning filesystem and becomes invalid after the
session closes. Copying its public fields does not create a trusted context.
Protected snapshots require their `OciStore` to belong to that same live context;
an unrelated plaintext output store is rejected before capture or output I/O.
Requested policies apply to registered roots too: persistent encrypted storage
cannot satisfy a `memory` request, and plaintext cannot satisfy `protected`.
Raw singleton initialization, realization, mounting and migration reserve root
ownership through asynchronous setup and cleanup. An overlapping managed root
configuration fails with a busy error and can be retried after the operation
finishes. Legacy OCI stores tied to a replaced singleton root must be recreated;
they cannot follow the replacement root into another session.
Hosts retain control of authentication, UI and RAM drafts, and must report any
recovery warning about potentially unsaved changes. `reset()` is terminal for
that session controller, including after an erase failure: use a new controller
or reload after completing/resetting storage. It cannot resume normal opening.

The managed `zfs` supports promise-based and synchronous file operations.
Promise-based mutations include an awaited persistence boundary; after
synchronous mutations the caller must await `session.flush()` before reporting
durable success. Callback APIs, streams, watchers and directory/line iterators
are rejected with an unsupported-operation error, including stream methods on
returned file handles. These surfaces must not escape the session's lifetime
and key checks.

Unreadable or malformed private metadata is an error, rather than an empty
catalog or an offline preference of `false`. Garbage collection completes its
snapshot/ref ancestry, image-config, alias and audit reachability checks before
any deletion. Missing required metadata, corrupt records or unsupported ref
graphs abort collection and preserve the remaining backing records.

In the 0.12 transition, `/sandbox` vault, encrypted-store and directory-store exports remain
compatibility aliases and are deprecated for new integrations. They remain
available throughout 0.x; removal is reserved for the next major version after
consumer migration. The older contents-only `encryptedMount` remains a legacy
`/sandbox` API and does not protect filenames. Prefer `/storage` and its managed
session for new code. Legacy
raw browser initialization and persistent manifest mounts require an explicit
`storagePolicy: 'plaintext'` choice. Caller-supplied filesystems remain a legacy
integration path with caller-owned persistence; they do not acquire a protection
guarantee from an `encrypted` flag. An explicitly requested `protected` policy
requires a live core context and cannot be silently satisfied by a raw filesystem
or plaintext backing. Low-level `OciStore` and `SnapshotManager` construction without a managed
context remains an explicit caller-owned compatibility path; the caller owns
its persistence policy and receives no managed-root encryption guarantee.
OCI blob encryption alone still leaves local JSON indexes, refs and snapshot
metadata exposed outside a protected root.

### Browser consumer

The host supplies its authenticated principal. `install()` restores a still-live
device-wrapped grant before probing and installs the existing same-origin lease
fetch patch. This example uses the default `protected` storage policy; a missing
key causes `open()` to fail. These examples are alternative roots: close the
current session before opening another in the same realm.

```ts
import { createZenFsPod } from '@artipod/core';
import { browserAdapters, createStorageSession, KeysService } from '@artipod/core/storage';

async function openProtectedWorkspace(principal: string) {
  const keys = new KeysService(browserAdapters());
  await keys.install(async () => principal);
  const session = createStorageSession({ keys });
  const storage = await session.open();
  const pod = await createZenFsPod({
    mounts: [{ name: 'work', path: '/repo', mode: 'rw',
      source: { kind: 'backend', backend: 'memory' } }],
  }, { storage }); // The manifest describes paths in the session's existing root.
  session.registerTeardown(async () => { pod.dispose(); }, 'Workspace pod');
  return { keys, session, pod };
}
```

Use `session.flush()` at explicit application durability boundaries and
`session.close()` to dispose registered consumers and release root ownership.
After successful reauthentication or a renewal that imports a different key
object, await `session.open()` again before accessing the context. It
authenticates that key against saved ciphertext; a locked context does not
silently adopt it during a filesystem read.
Key custody can outlive one storage session; when the host ends that custody,
call `keys.release()` and dispose its scheduler.

### Explicit memory and plaintext choices

`memory` needs no key, reports `memoryOnly: true`, and loses its data when closed.
The application must communicate that volatile status before accepting edits.

```ts
import { createStorageSession } from '@artipod/core/storage';

const session = createStorageSession({ policy: 'memory' });
const storage = await session.open();
await storage.zfs.promises.writeFile('/repo/draft.txt', 'volatile draft');
console.log(storage.memoryOnly); // true
await session.close();
```

For deliberately unencrypted persistence, supply the backing filesystem and
choose `plaintext` explicitly. For example, this browser IndexedDB store retains
plaintext names, contents and metadata:

```ts
import { resolveMountConfig } from '@zenfs/core';
import { IndexedDB } from '@zenfs/dom';
import { createStorageSession } from '@artipod/core/storage';

const filesystem = await resolveMountConfig({ backend: IndexedDB,
  storeName: 'intentionally-plaintext-workspace' });
const session = createStorageSession({ policy: 'plaintext', filesystem });
const storage = await session.open();
console.log(storage.protection); // 'plaintext'
await session.close();
```

### Native encrypted backing

`createNativeStorageAdapters(directory)` from `@artipod/core/storage/node`
backs the same protected lifecycle with a private directory on a local disk.
Only the versioned control record and writer lock remain outside encryption;
random generation directories contain numbered encrypted records. Replacements
are atomic within a directory, with data-file and containing-directory `fsync`.
The filesystem must support those operations; network filesystems and writers
on different hosts are outside this adapter's coordination model.

```ts
import { createStorageSession, KeysService, nodeAdapters } from '@artipod/core/storage';
import { createNativeStorageAdapters } from '@artipod/core/storage/node';

async function writeNativeWorkspace(directory: string, origin: string, principal: string) {
  const keys = new KeysService(nodeAdapters({ origin }));
  await keys.install(async () => principal);
  const session = createStorageSession({ keys,
    adapters: await createNativeStorageAdapters(directory) });
  try {
    const storage = await session.open();
    await storage.zfs.promises.writeFile('/repo/note.txt', 'encrypted on disk');
    await session.flush();
  } finally {
    await session.close();
    keys.release();
    keys.scheduler.dispose();
  }
}
```

`nodeAdapters` keeps device/grant persistence in memory by default and resolves
relative broker URLs against `origin`. Supply a structured-clone-capable
key-value adapter when the host deliberately supports durable wrapped grants;
raw keys still do not belong in application snapshots.

An exclusive `.writer.lock` remains held until pending I/O, close or reset
finishes. A dead process leaves a stale lock that fails closed: the adapter does
not automatically steal it. An operator may remove it only after checking that
no process owns the private directory.

This adapter provides encrypted storage for Artipod's virtual filesystem. It
does not expose a plaintext host mount for ordinary programs, implement FUSE or
OverlayFS, or add an SRT/native shell execution bridge. Host programs must not
edit its raw encrypted records.

## Key hierarchy

```
layer DEK  (random, per layer AND per writable-upper generation)
  └─ wrapped by → pod KEK (per pod/volume)
       └─ wrapped for principals (key envelopes, stored beside the pod):
            • user@server   — server/KMS unwraps after login          (login path)
            • device        — non-extractable WebCrypto keypair       (offline-grant path)
            • passkey PRF   — WebAuthn hmac-secret ceremony           (hardware-gated, optional)
            • recovery      — org escrow
LEASE (issued by a manager authority, signed):
  { podIds, principal, permissions, ttl, issuedAt }
  → holder may keep unwrapped KEKs in the memory keyring until expiry
```

Rotation and sharing are **rewrap, not re-encrypt** (add a recipient = wrap the KEK once more; remove = stop wrapping at next rotation). Key envelopes live as OCI referrer artifacts so changing recipients never changes the data's identity.

## At-rest format

- **Chunked AEAD**: AES-256-GCM (WebCrypto), ~4 MiB chunks, unique nonce + tag per chunk, encrypted filesystem index. Media type `application/vnd.artipod.volume.layer.v1.chunked+encrypted`. Chunking preserves random access and bounds browser memory.
- **Two identities per layer**: plaintext digest (diff ID — integrity/dedup inside a pod's history) and ciphertext digest (what stores, registries, and sync address). Sync and relays move ciphertext only.
- **Decrypt-on-read** happens in a chunk-store layer *below* `OciLayerFS`; plaintext exists only in memory caches. `OciViewFS` and the CoW upper are oblivious.
- **The writable upper is encrypted too** (per-generation DEK, same envelope). Layer-only encryption is theater — the upper holds the freshest data.
- **Superblock** (small logical record per pod store; also encrypted by the browser root): opaque pod ID, cipher suite, envelope refs, timestamps. Enough to enumerate and mount-request pods without any key; no names or clinical metadata (identifiers stay inside the ciphertext).
- OCIcrypt-compatible envelopes where formats align; the chunked layer format itself is artipod-specific.

## The keyring and leases

The manager (browser tab or server process) holds a session **keyring**: unwrapped KEKs with expiries — semantically Linux `keyctl` with timeouts. Read-only view at `/proc/keys` (names + expiries, never key material).

- **Leased keys are memory-only.** WebCrypto `extractable: false` keys keep raw bits out of JS entirely; we deliberately do **not** persist leased KEKs to IndexedDB (persistence is what would defeat the TTL). Tab close = locked. Login = restored.
- **The server specifies N** (lease TTL). Client enforcement is cooperative (timer, `visibilitychange` auto-lock, explicit `artipod lock`); the server's *hard* power is refusing re-issue after expiry without re-auth.
- **The login path has a shipped HTTP face**: `artipod serve --encrypt` runs the authority and issues leases at `/api/keys/login` — broker vs blind-host trade-offs in [serve.md](serve.md#encrypted-pods-and-key-leases-s55). With a `devicePublicKey` in the login body the KEKs cross ECDH-wrapped and unwrap to non-extractable keys.
- **Working trees encrypt at rest too**: two `/sandbox` mounts — `encryptedStoreMount` (preferred: the WHOLE tree — names, dirs, inodes, data — lives as encrypted numbered blocks; the backing shows no filenames and no tree shape, only block count/sizes) and `encryptedMount` (contents-only over a name-preserving backend). Plaintext lives only in the in-memory mirror; a locked keyring refuses the mount.
- **Two lock modes**, policy-chosen: `lock` (default — ciphertext remains; instant restore on login; offline-friendly) and `purge` (kiosk mode — blobs deleted at expiry; restore = re-sync).
- After lock, reads on encrypted mounts fail `EACCES` with a "pod locked — login to restore" hint; the console and UI surface it.

## Offline grants (the persisted exception)

For legitimate disconnection, a **signed offline grant** wraps pod KEKs to a **device keypair** (non-extractable, persisted in IndexedDB — a soft TPM):

```json
{ "pods": ["…"], "device": "device:8af…", "permissions": ["mount","read","write"],
  "notBefore": "…", "expires": "+24h", "maximumSnapshot": "sha256:…", "allowExport": false }
```

Unlock while offline = grant signature validates **and** a local ceremony passes (passkey tap / PIN). Clock discipline: the manager keeps a monotonic high-water mark of observed time and refuses key release on clock rollback. Revocation rides the next contact (CRL piggybacked on sync).

## Delegated authority (the certificate chain)

A manager can hold a **delegation certificate** from a parent authority:

```json
{ "subject": "manager:ship-7", "scope": { "pods": "clinical/*", "principals": "crew/*" },
  "maxLeaseTtl": "30m", "grantIssuance": true, "validity": ["…","…"], "sig": "…root…" }
```

Verification is pure signature-chain checking — fully offline. This is what makes the disconnection profiles work:

## Offline use cases

| Profile | Mechanism | Key lifetime posture |
|---|---|---|
| **Remote clinic (oil rig)** — depart, work 24 h offline, return and upload | Pre-departure `pull` + 24 h offline grant (device-wrapped KEKs); every visit a snapshot; return `push` moves only new digests | Grant-bounded; lost hardware after expiry = ciphertext + dead grant |
| **Interplanetary (light-delay)** — all operations local, sync merely delayed | Station manager holds a delegation cert; issues leases/enrolls devices locally, zero interactive round trips; anti-entropy sync converges regardless of delay | Local-authority leases; divergence = branches, merged explicitly |
| **Intermittent relay (cruise ship)** — laptops roam, ship server relays to shore | Ship manager = **blind relay** (ciphertext cache, no keys) and/or **entitled sub-authority** (short leases over LAN) per scope; store-and-forward drains when the satellite is up | Tightest TTLs of all — renewal is a LAN hop |

## Threat model (read before assuming more)

| Control | Protects against | Does NOT protect against |
|---|---|---|
| Chunked AEAD at rest (layers + upper) | stolen disk, backups, other users, registry/relay operators | anything holding the DEK |
| Memory-only leased KEK | forensics after TTL / tab close | a live compromised page during the window (CSP matters; secrets never in sandbox fs) |
| Non-extractable CryptoKeys | raw key exfiltration | *use* of the key by same-origin code while unlocked |
| Lease refusal at server | stale devices, departed staff (future access) | plaintext already decrypted offline — unrevokable, grant bounds the window |
| Offline grant + ceremony | casual/lost-device access | a jailbroken client that ignores timers |
| Delegation certs | forged local authorities | a compromised delegated manager within its scope (scope + validity bound the blast radius) |
| Blind relay mode | nosy/tampering intermediaries (digest-verified end-to-end) | traffic analysis (sizes/timing) |

Un-negotiable honesty: **you cannot revoke plaintext a device already decrypted**, and a browser enforces cryptography, not process boundaries. TTLs bound legitimate windows and at-rest exposure; they do not confine live malicious code. For agent confinement — which *is* enforceable — see [security-model.md](security-model.md).

## Command surface

```
artipod login                     # authenticate → lease → keyring populated
artipod lock [--all|<pod>]        # drop keys now
artipod status                    # lease expiries (also /proc/keys)
sudo artipod ls                   # enumerate ALL pod superblocks on this origin (locked included)
sudo artipod mount <id>|--all     # ceremony → elevated short-TTL lease → mount
artipod volume grant|revoke|rekey # recipient management (rewrap, not re-encrypt)
```
