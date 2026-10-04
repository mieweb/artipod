# Workspace checkpoint prototype

`@artipod/workspace-checkpoints` is a dependency-free Node.js ESM prototype
(Node 22+) for an Artipod root materialized as an ordinary local directory. It
implements the checkpoint contract without requiring the Ceph infrastructure
described in the architecture README. This is a local implementation seam for a
future Artipod service/CephFS snapshot backend, not an implementation of that
production service.

```js
import { ArtipodWorkspace } from './src/checkpoints.js';

const workspace = await ArtipodWorkspace.open({
  workspacePath: '/workspaces/example',
  storePath: '/var/lib/artipod/checkpoints'
});
const beforeTurn = await workspace.create();
// Editor writes and terminal commands use /workspaces/example as usual.
const result = await workspace.restore(beforeTurn.checkpointId);
console.log(workspace.rootId, result.changes);

// First create an empty destination directory outside the source workspace.
const branch = await workspace.fork(beforeTurn.checkpointId, {
  workspacePath: '/workspaces/example-branch'
});
```

`rootId` is a persisted UUID bound to the canonical workspace path in this store.
Reopening the same path/store recovers the same ID. An optional `rootId` on open
asserts that binding, or allocates the requested ID for a new root. Forks receive
a distinct root ID and independent files. `checkpointId` is SHA-256 of a canonical
filesystem manifest. Equal content, file/directory permissions and link targets
produce equal IDs; timestamps and optional caller labels do not affect them.
Checkpoints are immutable and can be shared across roots in one store. Labels
are returned to the caller rather than persisted by this backend.

The snapshot includes all regular files (binary or text), ignored files, `.git`,
empty directories, lower nine POSIX mode bits including executability, and
symlink targets. Symlinks are recorded as links and never followed during the
scan. Restoring a hardlinked regular file replaces its directory entry instead
of overwriting shared bytes. Restore removes post-checkpoint additions and
recreates deletions/type replacements. The root directory and unchanged
subdirectories retain their filesystem identities to preserve attached watchers.

`restore()` returns `{rootId, checkpointId, changes}` after completion and calls
`onDidRestore` listeners with that same result. Each change contains a relative
POSIX `path`, a `type` (`created`, `changed`, `deleted`), and a `kind` (`file`,
`directory`, `symlink`). A type replacement has a delete followed by a create;
an empty path identifies a change to the root directory's mode. Consumers can
emit filesystem provider events, reload open text models, and refresh Explorer
from this result. These backend events supplement normal native file watchers;
they do not track arbitrary terminal activity between checkpoint operations.

The external store has `roots/` and `workspaces/` binding metadata,
`checkpoints/<sha256>.json` manifests, and `blobs/<sha256>` content. It must neither
contain nor be contained by the workspace, including through symlink aliases.
No snapshot metadata is written into the workspace. Restore validates the full
manifest, parent topology, paths and every blob checksum before touching files.
Malformed snapshots, missing blobs and corrupt data therefore leave the current
workspace intact. Operations sharing a store are serialized in process; an
exclusive `.checkpoint-lock` rejects a second process. If a process crashes,
remove that lock only after confirming its owner is stopped.

## Prototype limits

- Quiesce agent tools, terminals, task runners and other external writers before
  create, restore or fork. The in-process/store lock cannot pause OS processes.
  A scan has per-file race checks but is not an atomic filesystem snapshot. In
  particular, it is not an isolation/security boundary against a process racing
  path changes. A production backend should freeze the tenant or use a storage
  snapshot and atomic root switch.
- Restore reconciles the live tree in place. Validation errors are fail-safe;
  an I/O error, process crash or power failure during application may leave a
  partially restored tree. There is no crash-recovery journal or fsync durability
  guarantee yet. Stop writers and retry a valid checkpoint after resolving the
  underlying error.
- All file bytes are read when creating a checkpoint, and restore preloads all
  referenced blobs into memory. Content is deduplicated but there is no incremental
  tree index, compression, quota, retention or garbage collection. Use small
  disposable workspaces for this prototype.
- POSIX/macOS and Linux are the tested filesystem model. Ownership, timestamps,
  ACLs, extended attributes, special permission bits, sparse extents and hardlink
  identity are not restored. Sockets, FIFOs and devices are rejected. Filename
  backslashes are rejected to keep stored relative paths portable and safe.
  Files behind symlinks are outside the snapshot; mounted subdirectories are
  ordinary traversed directories and must be within the intended workspace scope.
- Dirty unsaved editor contents belong to the host's text-model layer. The VS Code
  integration must save at capture boundaries and revert/reload affected models
  after restore. The backend operates on filesystem state only.

Run `npm test` for the backend tests. The main proof uses ordinary editor-style
file writes and an actual child process to edit/delete/create files, then restores
and compares the complete tree, modes and symlink targets. Additional tests cover
fork isolation, persistent IDs, corrupted snapshots, traversal protection,
serialization, readonly directories and hardlink-safe restoration.
