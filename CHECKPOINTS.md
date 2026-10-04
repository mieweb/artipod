# Artipod workspace checkpoints

`@artipod/core/checkpoints` connects a local Desktop workspace to the current
Artipod runtime. It opens a real `createZenFsPod` host-directory root and uses
Artipod's OCI `SnapshotManager` history. The same directory can be opened with
`artipod run -it --dir /path/to/workspace`. `artipod serve --publish <directory>`
separately exposes a synchronized copy through its registry and browser UI.
Desktop edits, a native terminal with that working directory,
and Artipod's interpreted shell all write to the same files.

Build with `npm run build`, then:

```js
import { ArtipodWorkspace } from '@artipod/core/checkpoints';

const workspace = await ArtipodWorkspace.open({
  workspacePath: '/workspaces/example',
  storePath: '/var/lib/artipod/desktop-mappings'
});
const beforeTurn = await workspace.create({ label: 'before request' });
await workspace.exec('echo "from the pod shell" > /terminal.txt');
const result = await workspace.restore(beforeTurn.checkpointId);
console.log(workspace.rootId, result.changes);

// First create an empty destination directory outside the source workspace.
const branch = await workspace.fork(beforeTurn.checkpointId, {
  workspacePath: '/workspaces/example-branch'
});
```

`rootId` is the real 16-digit hexadecimal `podId` stored in
`workspace/.artipod/superblock.json`. It is stable across reopen and does not
depend on the Desktop mapping-store location. `checkpointId` is a stable,
persisted Artipod snapshot ID such as `snap-0123456789ab`, rather than a content
hash. Its manifest and cumulative index live in `.artipod/oci/snapshots/`;
content uses Artipod's digest-verified OCI tar layers. Labels are persisted.
Recreating an identical snapshot may allocate a new ID. Restoring changes HEAD
but retains later snapshots for redo. A fork has a distinct pod ID and copies
the selected snapshot's ancestor chain so those same snapshot IDs remain usable
in the fork. It has independent files and an independent OCI store.

`storePath` remains an external directory for the Desktop bridge's request-ID
mappings; it is not a second snapshot implementation. The prior prototype's
standalone SHA-256 manifest/blob store is superseded, and its historical IDs
are not automatically migrated. Snapshot bytes are now in the actual pod.

The complete workspace snapshot includes regular files, ignored files, `.git`,
empty directories, lower nine POSIX mode bits, and symbolic-link targets.
Symlinks are captured as links, including dangling and external links; their
targets are not traversed. Binary content is preserved. Ordinary `mnt`, `dev`
and `branches` directories are included. Only the reserved root paths
`/.artipod` (persistent pod metadata) and `/proc` (runtime state) are excluded.
Do not put application data in those reserved paths. OCI whiteout names
(`.wh.*`), sockets, FIFOs, devices and filenames containing backslashes are
rejected explicitly instead of silently losing data.

`restore()` validates snapshot history, digests, file indexes and parent
structure before changing the live tree. It restores files in place, removes
post-checkpoint additions, recreates deleted paths, and handles file/directory/
link replacements. Replacing modified regular files avoids changing hardlinked
content outside the workspace. The root directory and surviving subdirectories
retain their identities so native filesystem watchers stay attached.

`restore()` returns `{rootId, checkpointId, changes}` after completion and calls
`onDidRestore` listeners. Every change has a relative POSIX `path`, `type`
(`created`, `changed`, `deleted`) and `kind` (`file`, `directory`, `symlink`).
Type replacement emits deletion then creation; an empty path means root-mode
change. Desktop uses these events for the `artipod://` mirror and canonical
file editors, and refreshes Explorer; native OS watchers also observe the real
writes. Save unsaved editor models before capture, and revert/reload models
after restore—the backend operates on disk state.

The implementation starts one short-lived worker per operation. Each worker
realizes the actual Artipod hostDir pod. This avoids leaking ZenFS's singleton
mounts/cache between roots and ensures native writes are seen on subsequent
operations. Snapshot filesystem reads use Node's native lstat/readlink/mode
semantics against that same root; manifests and layers are still the real
`SnapshotManager`/`OciStore` format. `exec()` runs one fresh interpreted shell
command in the pod; it does not retain shell environment between calls and is
not a native container process. An interactive terminal should keep its own
Artipod `TerminalSession` or use the CLI.

## Prototype limits

- Stop terminal commands, tasks, background servers and other external writers
  before capture or restore. A workspace lock serializes checkpoint API calls
  across processes; it does not pause native processes, CLI/serve commands, or
  independently owned Artipod terminals. The lock lives in
  `.artipod/checkpoint-lock`; remove a stale lock only after its owner is stopped.
- This is not an atomic storage snapshot or a process isolation boundary.
  Validation fails before workspace mutation, but an I/O error or crash during
  application can leave a partial restore. There is no crash journal or fsync
  guarantee. Quiesce writers and retry after resolving the underlying failure.
- Reads scan the workspace and restore loads the snapshot chain's layers into
  memory. Use a small local workspace for the prototype. Old CLI snapshots that
  used broader default exclusions may not represent the same complete scope.
- Host files require an unencrypted local pod. Browser-only/remote pods and key
  custody for encrypted pods are outside this Desktop adapter's scope.
- Ownership, timestamps, ACLs, extended attributes, special permission bits,
  sparse extents and hardlink identity are not restored. POSIX/macOS/Linux are
  the tested filesystem model. Mounts beneath the root are traversed normally.
- Snapshot compaction/GC is not coordinated with Desktop's durable request-ID
  mappings. Do not compact away snapshots still referenced by conversations.

Run `npm run test:checkpoints` after building for host filesystem integration
checks, and `npx vitest run src/oci/snapshot.test.ts` for core SnapshotManager
regressions. Tests exercise real pod-shell commands, a native child process,
editor-style writes, restore/redo/fork, stable identities, complete directory
scope, permissions, symbolic links, corruption and path safety.
