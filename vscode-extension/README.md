# Artipod workspace checkpoints for Ozwell Desktop

This prototype keeps a normal local `file://` folder as the workspace. Native
terminals, Git, language servers and filesystem watchers use that same folder.
Artipod checkpoints capture every entry, including ignored files and `.git`, in
extension global storage outside the workspace. Enable
`artipod.checkpoints.enabled` only in a dedicated, trusted, single-folder local
workspace. The default is off. Remote and multi-root workspaces are rejected.

Load this directory with Ozwell's `--extensionDevelopmentPath` flag. No build or
third-party runtime dependencies are required. For a self-contained extension
package, `npm run prepare-backend` copies the backend to `vendor/checkpoints.mjs`;
the `vscode:prepublish` hook also performs this step. Do not move the unpackaged
extension away from the Artipod source tree before preparing the backend.

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
Output `checkpointId` is the content-addressed Artipod snapshot. The durable
mapping is keyed by the complete session/request/checkpoint tuple and root ID.
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

This is a local copy-based prototype, not a Ceph snapshot mount. Pause external
writers before creating or restoring a checkpoint. It cannot stop running
terminal processes. Storage is retained without automatic garbage collection.
Only request boundaries captured by the core patch have whole-workspace
semantics; arbitrary per-tool undo points need their own capture hook. Fork is
available through the bridge and backend API; automatic conversation branching
into a new physical workspace requires separate UI/lifecycle work.
