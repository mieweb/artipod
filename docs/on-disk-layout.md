# On-disk layout

> **Status: ✅ implemented** — this page describes what actually lands on disk today: the CLI's `~/.artipod` home, the hidden `/.artipod` store inside every pod, and which of those bytes are plaintext vs ciphertext. Formats live in `@artipod/core/oci` (`src/oci/store.ts`, `src/manager/pod-store.ts`).

Two distinct things share the `.artipod` name:

1. **`~/.artipod/`** — the CLI's home directory: kept pods + a local OCI store.
2. **`/.artipod/`** *inside each pod* — the pod's own superblock and blob store (hidden; `tree -a` to see it). Browser pods have the identical layout inside IndexedDB/OPFS.

## The CLI home (`~/.artipod`)

```
~/.artipod/
├── pods/                        # kept pods — one dir per pod, dir name == pod id
│   └── d66087574f38a990/        #   (--pods <path>, env ARTIPOD_PODS)
│       ├── your files…          #   the pod's root fs, as plain host files
│       ├── proc/                #   empty runtime scaffolding (see below)
│       └── .artipod/            #   the pod's own store — next section
└── store/                       # shared local OCI store (--store <path>, env ARTIPOD_STORE)
    ├── oci-layout               #   {"imageLayoutVersion":"1.0.0"}
    ├── index.json               #   refs → manifest descriptors (schemaVersion 2)
    └── blobs/sha256/<hex>       #   digest-addressed manifests, configs, layer tars
```

### `pods/<id>/` — kept pods

- The directory **is** the pod's root filesystem (ZenFS Passthrough over `node:fs`). `artipod pods` lists them, `artipod run -it <id-prefix>` resumes one, `artipod rm` / `artipod prune` delete them — and only touch directories that contain a readable superblock.
- The directory name equals the pod id: `run` pre-seeds `.artipod/superblock.json` before boot.
- `proc/` is an empty real directory materialized by the virtual `/proc` mount — runtime scaffolding, never user data. The CLI ignores it when deciding whether a fresh pod was touched (**create-on-write**: exit without writing anything and the kept dir is removed again).
- `--rm` keeps the pod in RAM (nothing on disk at all); `--rm --disk` uses a temp dir deleted on exit; `--dir <path>` keeps the pod at a path of your choosing instead of the pods root.

### `store/` — the shared local OCI store

A standard **OCI image-layout directory** (`OciLayoutPodStore`): `oci-layout` marker, `index.json`, `blobs/sha256/`. It backs `push`/`pull`/`clone` and REF lookup across all your pods, and because it is spec-compliant you can inspect or back it up with `skopeo`, `crane`, or plain `tar`.

## Inside every pod: `/.artipod/`

| Path | Contents |
|---|---|
| `superblock.json` | **Always cleartext**: `formatVersion`, opaque `podId`, `cipher` (`none` \| `aes-256-gcm-chunked`), timestamps. Enough to enumerate and mount-request pods without any key; deliberately no names or clinical metadata. |
| `oci/blobs/sha256/<hex>` | Original blobs, immutable and digest-verified on read. Ciphertext when the pod is encrypted; `<hex>.alias` files then map plaintext digests → ciphertext twins (the store's addressing never changes when encryption is on). |
| `oci/uncompressed/sha256/<hex>` | Decompress-once twins of gzipped layers, addressed by diff ID. |
| `oci/indexes/sha256/<hex>.json` | Layer-index artifacts (per-file entry tables) by diff ID — what makes lazy hydration and per-file reads possible. |
| `oci/refs/<urlencoded-ref>.json` | Name → manifest digest (`ref`, `manifestDigest`, `mediaType`, `pulledAt`). |
| `oci/snapshots/` | `HEAD`, plus per-snapshot `<id>.json` manifests and `<id>.index.json` cumulative indexes. |
| `oci/upper/` | CoW upper for layered (base + upper) pods. |

## The uppers — where writes live before they are layers

"Upper" is OverlayFS vocabulary: opened layers form the read-only **lower**,
and every write lands in a writable **upper** stacked on top (the same idea
as `upperdir` in Linux OverlayFS or a container's writable layer). Pushing
freezes the upper into new diff layers; until then the upper *is* your
uncommitted local state. There are three of them:

| Upper | Where | Lifetime |
|---|---|---|
| Layered-pod upper | `/.artipod/oci/upper/` (table above) | Persistent — part of the pod store; frozen by `commit`/`snapshot`. |
| **Basis-overlay upper** (`artipod open <ref>` / `sync.basis`) | Mounted at `/.artipod/upper/<urlencoded-ref>`; backing is **in-memory by default** — safe because auto-push drains it into a new head within ~2 s | Session — unless the embedder passes `sync.basis.upperConfig` (any ZenFS mount config) to place it on persistent storage. A **cow fork** is exactly that: `autoPush: false` + a persistent upper. |
| Browser-demo cow upper | OPFS `artipod-fs/uppers/<urlencoded-ref>/` (plain real files; IndexedDB store `artipod-upper::<urlencoded-ref>` when OPFS is unavailable) | Persistent until the fork is discarded. |

### The browser's "disk" (artipod-sync demo)

The demo's whole filesystem lives in the origin's OPFS under one sandbox
directory (falling back to IndexedDB where OPFS is unavailable):

```
artipod-fs/                     ← OPFS sandbox dir (the ZenFS root)
├── work/<id>/                  ← blank workspaces (?artipod=<id>); empty+abandoned ones are swept
├── open/<sanitized-ref>/       ← overlay mount points for opened pods (view, not data)
├── uppers/<urlencoded-ref>/    ← persistent cow-fork uppers (real files)
└── .artipod/…                  ← the pod store, exactly the table above
```

`/proc/storage` inside the shell renders this same map live (`idb/`,
`opfs.json`, `origin.json`), and the catalog's Root console can walk all of
it — a workspace shell is confined to its own root and sees none of it.

## What is plaintext, what is ciphertext

Encryption ([encryption.md](encryption.md)) is **per pod store**, opt-in, and covers *blobs* — layers, snapshots, the CoW upper — as chunked AEAD (AES-256-GCM). The honest map:

| Bytes on disk | Unencrypted pod | Encrypted pod |
|---|---|---|
| `superblock.json` | cleartext | cleartext (by design — opaque id only) |
| `.artipod/oci/blobs/…` (layers, snapshots, manifests) | plaintext | **ciphertext** (+ digest aliases) |
| `.artipod/oci/upper/…` (layered pods) | plaintext | **ciphertext** |
| `oci/uncompressed`, `oci/indexes` | plaintext | not materialized in plaintext; indexes ride inside the ciphertext |
| **Passthrough working tree** (`pods/<id>/your-files`) | plaintext | **plaintext — see below** |
| `~/.artipod/store` (what `push` moved) | plaintext | **ciphertext** (encrypted pods push ciphertext only) |

Two consequences worth internalizing:

- **A host-dir pod's working tree is plain host files, period.** That is the point of Passthrough — your editor, `git`, and backups see real files. Store-level encryption protects history (snapshots, commits, pushed refs), not the live tree. If the live tree itself must be encrypted at rest, put the pods root on encrypted storage (FileVault, LUKS, an encrypted APFS volume/image for `~/.artipod`), or use `--rm` (RAM-only, nothing ever on disk) / `--rm --disk` (temp dir, deleted on exit). Browser pods differ: their "disk" is IndexedDB/OPFS and the writable upper lives in the store, so encryption covers the freshest data too.
- **The CLI creates unencrypted pods today** (`cipher: "none"`). Encryption is wired at the library/manager level — `createZenFsPod({ authority: { encrypt: true, … } })` binds the store to a keyring-held KEK with lease TTLs, locked reads fail `EACCES`, and `purge` mode deletes blobs at lock ([encryption.md](encryption.md) has the full key hierarchy and threat model). There is no `artipod run --encrypt` flag yet, because a CLI pod needs a key-custody answer (passphrase-derived KEK? OS keychain? manager login?) before the flag would be honest.

## Knobs

| What | Flag | Env | Default |
|---|---|---|---|
| Pods root | `--pods <path>` | `ARTIPOD_PODS` | `~/.artipod/pods` |
| Local OCI store | `--store <path>` | `ARTIPOD_STORE` | `~/.artipod/store` |
| Keep pod elsewhere | `--dir <path>` | — | pods root |
| Nothing on disk | `--rm` (RAM) / `--rm --disk` (temp dir) | — | kept |
