# Encrypt browser scratch workspaces and filename metadata

Status: implemented on `fix/browser-storage-encryption`; pull-request review fixes and CI validation are recorded in [#117](https://github.com/mieweb/artipod/pull/117). Original findings verified on 2026-10-21 against `artipod` commit `422da9754d3a9aa0df2289aca66ffa60310c8e0a`.

Tracking issue: [mieweb/artipod#116](https://github.com/mieweb/artipod/issues/116). The issue contains the full implementation plan.

Persistent browser workspace contents and names must be encrypted before their first write to OPFS or IndexedDB. This includes blank scratch workspaces and metadata derived from encrypted files. Filenames, directory names, link targets, workspace/ref names and snapshot labels can contain PII and require the same protection as file contents.

## Implementation record

- Use one strict encrypted **whole-root filesystem**, rather than a second
  metadata codec or separate scratch encryption format. Existing logical OCI
  readers and writers therefore protect their JSON copies as well as blobs.
- `src/sandbox/browser-vault.ts` owns OPFS/IndexedDB generation selection,
  exclusive writer locks, verified migration and ciphertext-authenticated key
  adoption. Only a versioned opaque control record lives outside this filesystem.
- The SPA waits for broker policy and a usable key before opening persistence.
  A known encrypted vault fails closed; a brokerless deployment offers visibly
  labeled memory-only work. Generic library plaintext backends remain available
  to explicit callers, but cannot replace/bypass the SPA's protected root.
- Writable ref uppers are logical directory views inside the encrypted root.
  Legacy tree and encrypted-block uppers are converted there, preserving the
  source on failure. The legacy source reader accepts its historic mixed block
  format; the new physical target always requires ciphertext.
- Registry, catalog, editor and shell operations use the same root. Persistence
  errors propagate through flush. One tab owns the root, replacing the old
  advisory multi-tab model and raw-OPFS registry writer.
- Unsaved editor drafts remain only in tab memory through lock/unlock. Reset
  drains key-service and filesystem writes while retaining writer ownership
  through terminal deletion events, including blocked IndexedDB deletions.
  Damaged legacy uppers without a valid root block remain untouched for recovery.
- Hashed legacy IndexedDB uppers preserve numeric records even if an untouched
  mount contains only plaintext bootstrap blocks. Authenticated recovery can
  drain and reopen a failed generation without a page reload; drafts stay in
  tab memory and the UI reports potentially unsaved writes.
- Existing durable OCI whiteouts/history migrate as bytes. Legacy unsynced CoW
  deletions were held only in memory; no migration can recover them after an
  old tab exits. Making that journal restart-persistent is separate work.
- The underlying ZenFS block store already has a multi-block rollback defect:
  injected failure during a cross-directory rename can lose directory entries.
  This reproduces before this fix. Flush now reports failures, but ordinary
  edits are not made crash-atomic here. The verified generation protocol is for
  migration; repairing normal transaction rollback requires separate work.
- Scope is application-managed workspace and OCI persistence. Public model
  caches, browser history, application settings (including git author settings)
  and optional remembered credentials are not moved into this filesystem vault.
  Native host trees, SRT, and independent per-layer keys remain outside this fix.

### Verification

Final checks on the rebased implementation:

- Root lint/build and 771 Vitest tests plus 35 checkpoint tests passed.
- SPA lint/typecheck and 77 tests passed; `npm run build:ui` completed with
  version and struct-minifier assertions intact.
- Chromium 149.0.7827.55: the actual-app harness passed all 17 raw-storage
  checkpoints with zero plaintext marker leaks and zero unhandled page errors.
- The independent adapter harness passed OPFS and IndexedDB migrations,
  identical retained backend copies, interrupted cleanup, writer exclusion,
  raw write-history scans, backend anchoring and fail-closed OPFS probing.
  Its 12 cases also cover untouched plaintext-bootstrap broker uppers, first
  writes after migration/reopen and preservation of damaged upper records.
- The locked gate was visually checked in dark mode; text contrast was 17.18:1.
- Pull requests targeting the parent `artipod` branch run the regular CI jobs.
  A dedicated Chromium CI job runs both raw-adapter and actual-app storage
  verification, including release/reload, dirty drafts and offline lease expiry.


Targeted tests cover first-write ciphertext, cached access while locked,
queued write/quota failures, writer exclusion, corrupt/missing ciphertext,
interrupted migration and cleanup, legacy upper modes/symlinks and same-key
renewal versus changed-key rejection. Browser verification scripts intercept
raw writes as well as inspecting final OPFS/IndexedDB contents, using synthetic
markers only. Final command results are recorded with the pull request.

### Interrupted OPFS publication — issue #129 (2026-10-22)

- PR review follow-up (2026-10-23): fixed registry save error retention across
  unrelated successful field updates. Matching retries, explicit deletion and
  authenticated recovery acknowledge the covered failures; recovery preserves
  its warning and newer failures. SPA lint/typecheck and 101 tests pass.
- Deterministically reproduced the original implementation in Chromium by
  destroying a page immediately after creating numeric record `129129`.
  Its backing length was zero with no envelope header; the existing root and
  inode records retained `APODENC1`. Strict reopening reported
  `EncryptedStore: plaintext backing block refused`. Diagnostics used only
  synthetic record IDs, lengths and envelope headers.
- Ciphertext now closes under `.artipod-stage-v1-<id>-<random token>` before
  native OPFS file `move()` publishes the numeric name. The native capability
  is required; unsupported OPFS cannot fall back to unsafe publication.
  Reopening authenticates all canonical records and nonempty stages before
  removing abandoned stages. Empty numeric records, unknown names and corrupt
  stages still fail closed, retaining the originals. Recovered stages produce
  a warning through the public session and SPA. This does not replay pending
  transactions or repair the broader ZenFS multi-block rollback limitation.
- `KeysService.flush()` drains authentication/device/grant persistence and the
  latest offline preference. The SPA's `saveFileSystem()` also drains registry
  mutations and debounced workspace/catalog probes before the final storage
  flush, repeating when that flush admits additional host work.
- CI runs deterministic interruption checks and actual-app save/reload checks
  with explicit OPFS and IndexedDB backends. The interruption harness captures
  only synthetic IDs, lengths and safe envelope fields, with no keys or payloads.
- Verification: core lint/build/full typecheck pass, with 984 Vitest tests and
  35 checkpoint tests. SPA lint/typecheck and 96 tests pass; static export
  retains its version and struct-minifier assertions. Chromium 155 passes all
  six native interruption cases, both complete app runs (including a held
  automatic push), the 12 migration cases and the packed native/OPFS/IndexedDB
  consumer. Raw scans report zero private-marker leaks and no unhandled browser
  errors. The interrupted-stage warning is readable in dark mode.

Reproduce the browser checks with Playwright and Chromium installed in the test
environment (or provide `PLAYWRIGHT_MODULE_PATH` and
`CHROMIUM_EXECUTABLE_PATH`):

```sh
# Disposable encrypted app server, after npm run build:ui:
ARTIPOD_UI_DIR="$PWD/dist-ui" node dist/cli.js serve --port 2786 --encrypt \
  --store /tmp/artipod-browser-test/store --authority /tmp/artipod-browser-test/authority --no-exec
# In another terminal:
TEST_STORAGE_BACKEND=opfs BASE_URL=http://127.0.0.1:2786 node examples/artipod-spa/scripts/verify-encrypted-storage.mjs
TEST_STORAGE_BACKEND=indexeddb BASE_URL=http://127.0.0.1:2786 node examples/artipod-spa/scripts/verify-encrypted-storage.mjs
# Independent raw adapters: each creates a disposable localhost fixture server:
node examples/artipod-spa/scripts/verify-vault-migration.mjs
node examples/artipod-spa/scripts/verify-encrypted-interruption.mjs
```

Use an empty disposable server directory. The app check publishes unique
synthetic refs; the raw adapter check creates legacy fixtures in fresh browser
contexts. Both inspect write history and final persistence. The app check also
proves its observer detects a canary written and removed before inspection.

The sequence below is the original implementation plan; the whole-root design
satisfies the metadata boundary without changing logical OCI wire formats.

## Confirmed problems

1. **Blank scratch files bypass encryption.** The SPA chooses `encryptedStoreMount` only for writable ref workspaces with an available broker key. Blanks instead use `/work/<id>` on the ordinary persistent root. A ref opened without a key also selects an ordinary upper. [Workspace selection](https://github.com/mieweb/artipod/blob/422da9754d3a9aa0df2289aca66ffa60310c8e0a/examples/artipod-spa/lib/services/pod-session.ts#L89-L116)
2. **Encrypted filenames escape through derived metadata.** The encrypted upper protects directory records and file contents, but `OciStore.putLayerIndex` writes a second filename listing directly as JSON. Snapshot manifests and cumulative indexes also use direct writes. The normal overlay push path calls `putLayerIndex`, so the problem is not limited to optional snapshots. [Layer indexes](https://github.com/mieweb/artipod/blob/422da9754d3a9aa0df2289aca66ffa60310c8e0a/src/oci/store.ts#L262-L279), [overlay push](https://github.com/mieweb/artipod/blob/422da9754d3a9aa0df2289aca66ffa60310c8e0a/src/manager/overlay-sync.ts#L145-L147), [snapshots](https://github.com/mieweb/artipod/blob/422da9754d3a9aa0df2289aca66ffa60310c8e0a/src/oci/snapshot.ts#L263-L294)
3. **Workspace names also escape.** Raw OPFS `ui-state.json` contains workspace/ref IDs, actor and status, not ordinary per-file names. OCI ref and hydration records contain ref names in their contents and encoded backing filenames. These identifiers may themselves contain PII. [UI registry](https://github.com/mieweb/artipod/blob/422da9754d3a9aa0df2289aca66ffa60310c8e0a/examples/artipod-spa/lib/services/ui-state.ts#L11-L26), [raw registry writer](https://github.com/mieweb/artipod/blob/422da9754d3a9aa0df2289aca66ffa60310c8e0a/examples/artipod-spa/lib/services/ui-state.ts#L53-L82), [hydration state](https://github.com/mieweb/artipod/blob/422da9754d3a9aa0df2289aca66ffa60310c8e0a/src/manager/hydration.ts#L300-L315)

Synthetic probes confirmed the separation: all four backing blocks of an encrypted upper contained neither the test filename nor payload, while `buildOverlayHead` and `SnapshotManager.create` produced plaintext local indexes containing the test filename. The published index blob went through encrypted `putBlob`; its separate local index copy did not.

## Storage contract

- Persistent browser workspaces, including scratch, use encrypted storage by default. In encryption-required mode, a missing, expired or unavailable key means locked storage; it never selects a plaintext mount. A deployment without a broker offers a separate, visibly identified memory-only mode.
- Reuse the existing broker lease and encrypted block-store implementation. Where no approved persistent key is available, refuse persistent editing or offer clearly labeled memory-only scratch. Do not invent an unprotected key file to preserve persistence.
- Protect sensitive metadata both in record contents and in backing path names. Use random opaque storage IDs with encrypted name mappings; the existing unkeyed hash of a ref does not provide protection against guessing that ref.
- Leave only an enumerated bootstrap record outside encryption: format/version, cipher choice, opaque storage/generation IDs and cryptographic envelope information. It must contain no user names, paths, refs, labels or link targets.
- Encrypt before every protected backing write. Plaintext may be processed in memory; neither scratch files nor migration intermediates may be staged as plaintext on persistent storage.
- On key or persistence failure, report locked/error/unsaved state. Do not treat failed decryption as an empty registry, create a replacement plaintext store, or report queued writes as saved.

## Implementation sequence

### Phase 1 Define protected storage and reproduce regressions

Introduce one browser workspace storage service with durable encryption policy, opaque identity, open, flush, close and retire operations. Select policy from configuration and stored workspace format, not `getKey()` truthiness. Distinguish encrypted-locked, explicitly plaintext and unknown/offline states. Define a versioned protected metadata codec and an opaque bootstrap format shared by OPFS and IndexedDB adapters.

Add regression fixtures for a broker-backed blank workspace, overlay push producing a local index, snapshot creation and a named UI registry entry. Use synthetic markers in names and contents. Capture every backing write as well as final stored state.

### Phase 2 Encrypt scratch before accepting edits

Mount `encryptedStoreMount` at the logical scratch root before the first user file or directory is created. Share the storage service with ref uppers. Preserve the same encrypted workspace identity through reopen, navigation and publish.

Update scratch publishing to read logical decrypted files, flush protected writes, verify durable publication, and only then retire the physical scratch store. Update close/unmount and catalog/app inspection to use the storage service instead of walking raw `/work` paths or interpreting numbered blocks as user files. Exclude active, locked and migrating stores from cleanup.

Block encrypted ref/scratch opening without keys. Reconnect or login must construct the correct encrypted mount; adopting a key into an already-plaintext mount is insufficient. Ensure queued encryption/write failures propagate through flush and save status.

### Phase 3 Protect all metadata copies and readers

Route sensitive metadata through the protected codec/filesystem, including:

- Local layer indexes and caches produced by pull, lazy hydration, fetch-on-read, overlay push and rebuild.
- Snapshot manifests, cumulative indexes, HEAD/history and create, restore, fork/copy, commit and compact paths.
- Ref records, ref listing and hydration state, including physical filenames currently derived from encoded ref names.
- UI registry records and encrypted mappings from opaque IDs to workspace/ref names.

Update every reader, catalog reconciler, sweeper, hydration/proc projection and copy/GC operation together. Preserve the logical OCI and sync formats; this change protects local persistence and must not alter logical paths or whiteout behavior. Audit other path/name caches before declaring the contract met.

Keep raw-OPFS registry freshness: read the latest ciphertext, decrypt, modify, encrypt, write and close within the cross-tab lock. Do not fall back to a cached ZenFS view or retry a failed locked callback without its mutex. Locked/corrupt data must remain recoverable and must not be interpreted as missing.

### Phase 4 Enforce lifecycle and concurrent writers

Enforce one writer per encrypted physical store and an exclusive migration lock. Suspend operations that need keys when a lease expires; block protected access and unmount the workspace UI on lock. Existing plaintext caches may remain in process memory; this is not a memory-zeroization guarantee. Preserve pending edits or report their failure. Resume only against a validated key and storage generation.

Update cleanup and reconciliation for opaque IDs and generation records. A locked registry, crashed tab or interrupted migration must not cause an encrypted workspace to be swept as abandoned. Previously read plaintext in application/kernel memory cannot be retroactively revoked; the guarantee here covers application-managed persistent storage.

### Phase 5 Migrate legacy plaintext without another plaintext copy

1. Freeze affected writes across tabs and discover legacy scratch, ref uppers, raw metadata, and retained IndexedDB adoption/migration sources.
2. After obtaining the key, read legacy data into memory and write directly into a fresh opaque encrypted generation. Use a fresh namespace so existing-blob deduplication cannot skip encryption.
3. Verify decrypted contents, filenames, links, deletions, registry entries and history before committing. Protect migration details containing names in an encrypted journal.
4. Commit a small recoverable generation pointer under the exclusive lock. Keep enough version/checksum information to select a valid old or new generation after interruption; do not assume an atomic directory rename is available.
5. Remove legacy plaintext copies only after verification and pointer commit. Resume incomplete cleanup after restart. Report migration complete only when application-reachable legacy plaintext copies are removed.

Missing keys, quota exhaustion, corruption, lock changes and process/tab death must preserve a valid recovery path. Block persistent edits when migration cannot safely resume. Migration cannot promise secure erasure of historical browser backups or physical media remnants.

### Phase 6 Verify raw persistence and correct documentation

Add real-browser tests using raw OPFS handles and IndexedDB inspection, alongside targeted storage/core tests. Instrument writes so a final encrypted state cannot conceal an earlier plaintext write. Explain the exact protected scope and permitted opaque/cryptographic metadata in `docs/encryption.md`, `docs/on-disk-layout.md`, SPA badges and migration messaging.

Public model/runtime downloads may remain a documented separate cache; no workspace payload, filename or sensitive derived metadata may use that exception. SRT, native FUSE/OverlayFS support, new ciphers, independent per-layer keys and changes to the server broker trust model are outside this fix.

## Acceptance checks

| Scenario | Required result |
|---|---|
| New blank scratch before publish | Synthetic filename, directory and payload markers never reach raw OPFS/IndexedDB in plaintext; reopen recovers exact data |
| Scratch publish and publish-as | Data survives; original scratch backing stays encrypted until safely retired; refs and local indexes reveal no marker |
| Pull, lazy listing and hydration | Names remain protected in local records and paths while directory listing and fetch-on-read continue to work |
| Snapshot, restore, fork/copy and compact | Contents, names, labels, link targets and deletions survive without plaintext metadata copies |
| UI registry and catalog | Workspace/ref names are encrypted; locked entries remain locked rather than disappearing; sweep preserves live data |
| Missing key, failed login, offline boot and expiry | No plaintext fallback, replacement empty registry or successful-save indication after failed persistence |
| Interrupted writes and migration | Failed writes remain ciphertext and report errors; interrupted migration selects a valid generation without deleting unverified originals |
| Quota failure and corrupt ciphertext | Explicit recoverable error; originals remain available until verified replacement is committed |
| Concurrent tabs | No lost registry updates or conflicting store/migration writers |
| Legacy cleanup | No remaining application-reachable sensitive plaintext in old OPFS or retained IndexedDB copies |
| Brokerless mode | Clearly labeled memory-only work; no new persistent plaintext workspace |

The scan must inspect raw backing filenames and bytes, including encoded/escaped forms of markers, rather than the decrypted ZenFS view. Test file paths, directory names, workspace/ref names, labels and link targets separately. Validate every persistence call before publication and again after reload, failure and migration.

Run root lint, build and tests; SPA lint, typecheck and tests; `npm run build:ui`; and the new real-browser persistence suite. Follow `.github/copilot-instructions.md` before implementation commits. Close the issue only after regression tests and the raw-storage checks pass and the migration path is demonstrated.
