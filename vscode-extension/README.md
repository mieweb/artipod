# Artipod workspace checkpoints for Ozwell Desktop

This prototype realizes an actual Artipod using its ZenFS `hostDir` mount over
the local `file://` workspace. The editor, native terminals, Git, language servers
and the Artipod shell use that same directory. Its stable root ID is the pod ID
in `.artipod/superblock.json`. Checkpoints use Artipod's `SnapshotManager` and OCI
store under `.artipod/oci`, including ignored files and `.git`; `.artipod` itself
and Artipod's runtime `/proc` are excluded. Enable
`artipod.checkpoints.enabled` only in a dedicated, trusted, single-folder local
workspace. The default is off. Remote and multi-root workspaces are rejected.

From the Artipod repo run `npm ci && npm run build`, then run `npm ci` and
`npm run prepare-backend` in this directory. Load this directory with Ozwell's
`--extensionDevelopmentPath` flag. Packaging bundles the real Artipod runtime,
ZenFS and just-bash into `vendor/`, including the separate checkpoint and terminal
workers. It requires no global CLI or Node executable in the installed extension.
The `vscode:prepublish` hook performs the same bundle step. Rebuild the root and
bundle after changing Artipod source.

Use **Artipod: Open Pod Terminal** from the Command Palette, or click the
**Artipod &lt;pod ID&gt;** status item. The terminal identifies the pod and shows
which native directory is mounted at `/`. It runs Artipod's real `TerminalSession`
and interpreted shell in an isolated worker. For example:

```sh
pwd
ls
printf 'from the pod shell\n' > terminal.txt
artipod snapshot ls
```

Native Chat checkpoints appear in that snapshot history. A normal terminal
opened with **Terminal: Create New Terminal** still runs the host shell in the
same native directory; its filesystem changes are also captured. The Artipod
terminal is an interpreted shell, not a full native container. Checkpoint
operations reject while an Artipod terminal command is running; input typed
during a checkpoint resumes afterwards.

`artipod serve --publish /absolute/path/to/workspace` can publish this folder for
the browser UI. That browser opens a synchronized copy: `serve` snapshots the
folder at startup and materializes pushed heads back to it. It does not attach
the browser terminal directly to Desktop's live mount, and external native edits
are not continuously republished. Stop browser writes during checkpoint capture
and restore, and resync before expecting a browser copy to reflect restoration.
For a direct CLI shell over the same live pod, use
`artipod run -it --dir /absolute/path/to/workspace`.

The small Ozwell core patch awaits capture immediately before invoking an agent
and invokes restore from the existing **Restore Checkpoint** action. Conversation
history handling stays in VS Code. The extension cannot install that internal
hook using the stable public extension API alone.

The internal commands use this protocol:

| Command | Input | Result |
| --- | --- | --- |
| `_artipod.checkpoints.capture` | `{sessionId, requestId, checkpointId, requireExisting?}` | `{providerId: 'artipod', rootId, checkpointId}` |
| `_artipod.checkpoints.restore` | Same VS Code IDs | Artipod IDs, `workspaceUri`, `workspaceAliases`, `changes: [{uri, type}]` |
| `_artipod.checkpoints.fork` | Same IDs plus absolute `targetPath` for an empty existing directory; optional `targetSessionId` | Artipod IDs and destination `workspaceUri` |

Input `checkpointId` is the VS Code request boundary (or a temporary redo key).
Output `checkpointId` is Artipod's stable `snap-…` snapshot ID. The durable
mapping is keyed by the complete session/request/checkpoint tuple and root ID.
Mappings live in extension global storage outside the pod; filesystem snapshots
live in the pod's own OCI store.
Repeated capture returns the original snapshot. Unknown historical checkpoints
fail closed; they never silently degrade into a partial file restore. Capture
saves dirty text and notebook documents inside the root first and fails if a save fails.
Resumed AgentHost turns pass `requireExisting: true`: a missing mapping is rejected
before saving editors or creating a snapshot, because the pre-turn state can no
longer be reconstructed. This flag does not change the mapping key.
`workspaceUri` retains the original folder URI spelling; aliases cover the
canonical local path and the Artipod mirror so the core also reloads their models.

The extension also registers a writable `artipod://<root-id>/...`
`FileSystemProvider` mirror. **Artipod: Open Active File in Workspace Mirror**
opens the active local file through that provider. Keep the `file://` folder as
the workspace: a virtual URI cannot supply a native terminal working directory.
The provider forwards native file watcher events and emits explicit precise
create/change/delete events after restore. The Ozwell core patch reloads local
models and refreshes native Explorer/watchers after the complete restore,
including dirty loaded documents whose disk bytes did not change.

Run `npm test` here for bridge and provider tests. They use the real Artipod
backend with minimal VS Code API doubles; they cover ordinary editor saves,
actual terminal subprocess writes/deletes, durable mappings after restart,
isolated forks, provider change events and path escape rejection. They do not
replace the Ozwell native checkpoint action integration tests or a desktop smoke
test.

This uses Artipod's native snapshot layers and materialized checkout over a local
directory. Pause external writers before creating or restoring a checkpoint.
The extension cannot stop host terminal processes or browser sync writes.
Storage is retained without automatic garbage collection.
Only request boundaries captured by the core patch have whole-workspace
semantics; arbitrary per-tool undo points need their own capture hook. Fork is
available through the bridge and backend API; automatic conversation branching
into a new physical workspace requires separate UI/lifecycle work.
