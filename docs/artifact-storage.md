# Protected Artifact byte storage

`createArtifactStorage` borrows the application's `StorageSession`. One session
can serve many Artipods, Artifacts, eSheets and editor views. The host supplies
logical identity and an authorization callback; filesystem possession does not
grant permission. Close each borrowed handle when its view detaches. Only the
application closes the shared session.

```ts
import { createArtifactStorage } from '@artipod/core/storage';

const bytes = createArtifactStorage({
  session: applicationStorageSession,
  reference: { artipodId: 'authorized-group', artifactId: 'shared-document' },
  authorize: (reference, action) => hostPermissions.require(reference, action),
});

const attachment = await bytes.put(upload.stream(), {
  mediaType: upload.type || 'application/octet-stream',
  filename: upload.name,
});
// Capture canonical state once, including full Yjs state/deletion history,
// headers, source format and immutable attachment refs. Do not persist a
// second authoritative editor copy or a head ref in localStorage.
const revision = await bytes.saveSnapshot(capturedCanonicalSnapshot, {
  mediaType: 'application/vnd.example.document-snapshot+json',
});
const saved = await bytes.loadSnapshot();
if (saved) restoreCanonicalState(await new Response(saved.source).arrayBuffer());
await bytes.close();
```

`put` and `read` implement the framework-independent MIME/MDY codec byte-store
contract. They accept/return streams to simplify adapters, but this first version
buffers each object and enforces a **10 MiB maximum** (a lower `maxBytes` may be
configured). This is a small-object MVP, not the future bounded-memory large-file
implementation. The underlying encrypted filesystem still warms its plaintext
cache; this API does not make its overall cache or concurrent uploads bounded.

References identify immutable saved bytes inside their Artifact scope. Another
handle for the same logical identity may read them after a reload; other Artifact
scopes refuse them. Both bytes and media metadata use the managed encrypted
filesystem. A reference is returned only after a successful durability drain.
`saveSnapshot` then advances an encrypted current-head file using the core's
serialized replacement/fallback mechanism. It retains old immutable revisions;
retention and garbage collection remain application/storage policy.

Authorization runs before I/O, again after receiving upload data, and before each
read-stream chunk. Losing the key lease or closing the handle cancels active
reads/uploads and releases this adapter's read buffers. The UI must additionally
revoke its object URLs, decoded media and view state when the session locks. This
does not claim JavaScript zeroization. The host must scope the shared vault and
reference registry to its authenticated principal and audience.

Production key custody belongs to an authenticated `KeysService` or equivalent
host `StorageKeyProvider`. For synthetic Storybook data without a server,
`examples/protected-artifact-storage/browser-session.ts` demonstrates storing a
nonextractable CryptoKey in IndexedDB and reopening encrypted OPFS. That helper
provides **no authentication** and is intentionally excluded from package exports.
Any same-origin code can retrieve its demo key; it must not store PHI/PII.
Use a dedicated localhost origin and preserve an existing vault on open failure.

This implementation builds on the OPFS publication/reopen recovery in PR #130.
It does not replace attachment synchronization, Artifact registry resolution,
canonical collaboration, principal/account switching, or transport authorization.
