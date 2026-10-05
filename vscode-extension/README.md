# Artipod for Visual Studio Code

Use an Artipod terminal, save workspace snapshots, and open an earlier snapshot
as a separate workspace. These commands work in stock VS Code without editor
patches, a global Artipod installation, or a separately installed Node.js.

The first release supports one trusted local folder. Files stay in that folder:
VS Code editors, native terminals, Git, language servers, and the Artipod shell
see the same filesystem. Artipod keeps its stable pod ID and snapshot history in
`.artipod/` inside the folder.

## Get started

1. Open a dedicated project folder in VS Code and trust the workspace.
2. Run **Artipod: Open Pod Terminal** from the Command Palette. The terminal
   shows the pod ID and the native folder mounted at `/`.
3. Edit and save a file, or run a shell command such as:

   ```sh
   printf 'hello from Artipod\n' > hello.txt
   cat hello.txt
   ```

4. Let running terminal commands and background writers finish. Run
   **Artipod: Create Workspace Snapshot** and optionally give it a label.
5. Make more changes. Run **Artipod: Open Snapshot in New Workspace**, choose
   the saved snapshot, and select an existing empty folder outside the source
   workspace. VS Code opens that fork in a new window.

Your original folder and its unsaved buffers remain in place. The fork has a
new pod ID, the selected filesystem state, and the copied snapshot history.
Work can continue independently in either workspace.

## Commands

| Command | What it does |
| --- | --- |
| **Artipod: Open Pod Terminal** | Opens the interpreted Artipod shell over the current folder. The Artipod status item opens the same shell. |
| **Artipod: Create Workspace Snapshot** | Saves existing dirty workspace text/notebook documents, then captures the folder, including terminal changes. |
| **Artipod: Open Snapshot in New Workspace** | Lists snapshots and forks the selected state into an empty folder, then opens a new VS Code window. |
| **Artipod: Open Active File in Workspace Mirror** | Opens the active local file through the writable `artipod://` filesystem provider. |

Save new untitled buffers into the workspace before creating a snapshot: they
are not filesystem entries yet. Custom editors must be saved first. If a save
fails or a workspace editor remains dirty, snapshot creation stops.

Snapshots include ignored files, hidden files, `.git`, binary files, empty
directories, file modes, and symlinks. `.artipod` itself and Artipod's reserved
`/proc` runtime path are excluded. Snapshot IDs use `snap-…`; the pod ID remains
stable when the workspace is reopened. History stays on disk without automatic
garbage collection.

The Artipod terminal runs an interpreted shell, not the host operating-system
shell or a native container. Use `help` to see its available commands and
`artipod snapshot ls` to inspect the same snapshot history. A regular VS Code
terminal still runs your normal shell in the native directory.

The optional `artipod://` mirror reads and writes the same files. It forwards
native watcher events so terminal writes reach mirror documents. Keep the
ordinary local folder as the workspace so native terminals and tools have a
filesystem working directory.

## Current scope

- VS Code **1.101 or later**, with a desktop Node.js extension host. The runtime
  targets Node.js 22, introduced in VS Code 1.101.
- One trusted local folder containing an unencrypted Artipod. Remote, browser,
  multi-root, and virtual workspaces are not supported in this release.
- The local implementation uses OS filesystem operations. CI tests and packages
  the extension on Linux and macOS with Node.js 22 and 24; the graphical VS Code
  smoke test was performed on macOS. Windows needs separate platform testing,
  especially for permissions and symlinks.
- Wait for background tasks and native terminal writes to finish before
  capturing a snapshot. The extension coordinates its own Artipod terminals;
  it cannot stop other processes writing to the folder.
- Opening a snapshot always creates a separate workspace. This release does
  not expose an in-place restore command or rewind chat conversations.

`artipod serve --publish /absolute/path/to/workspace` can expose the folder to
Artipod's browser UI when the CLI is installed separately. The browser uses a
synchronized copy; it does not attach directly to the live Desktop mount.
For a direct CLI shell over that same folder, use
`artipod run -it --dir /absolute/path/to/workspace`.

## Experimental native Chat integration

`artipod.checkpoints.enabled` defaults to `false`. Leave it off in stock VS
Code. The terminal, manual snapshots, forks, and mirror do not need it.

This setting enables an internal bridge for a separate Ozwell/VS Code core
experiment. That experiment captures before an agent turn and delegates the
native **Restore Checkpoint** action to Artipod. The core patch is not part of
this extension and is not required for the standalone commands above.

The bridge commands `_artipod.checkpoints.capture`, `.restore`, and `.fork`
map `(sessionId, requestId, checkpointId)` tuples to Artipod snapshot IDs. Their
mappings live in extension global storage outside the workspace. They are
internal integration commands rather than a public extension API.

## Build and install a VSIX

From the Artipod repository, using Node.js 22 or later:

```sh
npm ci
npm run build
cd vscode-extension
npm ci
npm test
npm run package:vsix -- --pre-release
```

The package command rebuilds the backend, prepares the runtime, and writes
`dist/artipod-0.1.0.vsix`. It does not publish anything. In VS Code, run
**Extensions: Install from VSIX…** and select that file.

Packaging pins `@vscode/vsce` in the extension lockfile. The runtime is supplied
inside `vendor/`, including separately replaceable LGPL libraries and their
exact nested dependencies. It never downloads packages when activated.
See [third-party notices](THIRD_PARTY_NOTICES.md) and
[source/rebuild instructions](SOURCES.md).

The tests use the real Artipod backend with small VS Code API doubles. They
cover native terminal writes, durable snapshots, isolated forks, cancellation,
document saves, filesystem events, path validation, and a copied runtime
outside the source checkout. Test the resulting VSIX in an unmodified VS Code
build before publishing.

The Marketplace publisher must match an account authorized to publish this
extension. The manifest uses the `mieweb` publisher. Packaging a VSIX does not
require publisher credentials.

## Automated updates

The **VS Code extension** GitHub Actions workflow tests checkpoints and the
extension on Linux and macOS, then uploads installable VSIX artifacts. Once
the publishing identity is configured, pushing a `vscode-vVERSION` tag that
matches this extension's `package.json` publishes the tested artifact to the
Marketplace pre-release channel. Ordinary commits and pull requests only
build and test.

See [release setup and update steps](RELEASING.md). The extension version and
release tags are independent of the Artipod npm packages.
