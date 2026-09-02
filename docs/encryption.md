# Encryption, keys, and offline authority

> **Status: ✅ implemented** (normative) in plan Phases 4 (formats) and 6.5 (keyring/leases/grants) — see `@artipod/core/oci` (chunked-AEAD cipher) and `@artipod/core/manager` (keyring, authority, grants, locker). Builds on the envelope-encryption discussion in [horner/artipod-sync#1](https://github.com/horner/artipod-sync/issues/1).

**The principle everything follows from:** disk only ever holds *ciphertext + wrapped keys*; usable keys exist only in a memory keyring, on a lease with a TTL. "Access expires" is not something done to the data — it is the key evaporating. Login (or a grant, or a delegated authority) restores the key, never rewrites the data.

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
- **Superblock** (small, cleartext, per pod store): opaque pod ID, cipher suite, envelope refs, timestamps. Enough to enumerate and mount-request pods without any key; no names or clinical metadata (identifiers stay inside the ciphertext).
- OCIcrypt-compatible envelopes where formats align; the chunked layer format itself is artipod-specific.

## The keyring and leases

The manager (browser tab or server process) holds a session **keyring**: unwrapped KEKs with expiries — semantically Linux `keyctl` with timeouts. Read-only view at `/proc/keys` (names + expiries, never key material).

- **Leased keys are memory-only.** WebCrypto `extractable: false` keys keep raw bits out of JS entirely; we deliberately do **not** persist leased KEKs to IndexedDB (persistence is what would defeat the TTL). Tab close = locked. Login = restored.
- **The server specifies N** (lease TTL). Client enforcement is cooperative (timer, `visibilitychange` auto-lock, explicit `artipod lock`); the server's *hard* power is refusing re-issue after expiry without re-auth.
- **The login path has a shipped HTTP face**: `artipod serve --encrypt` runs the authority and issues leases at `/api/keys/login` — broker vs blind-host trade-offs in [serve.md](serve.md#encrypted-pods-and-key-leases-s55).
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
