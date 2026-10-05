# Releasing the VS Code extension

The Marketplace extension is `mieweb.artipod`. Version 0.1.0 was uploaded
manually as a pre-release. Future updates use `.github/workflows/vscode-extension.yml`:

- Pull requests and main/develop pushes run checkpoint and extension tests on
  Linux and macOS with Node.js 22 and 24, package a pre-release VSIX, and upload
  all four build artifacts. Node.js 22 covers the minimum extension runtime.
- A `vscode-vVERSION` tag runs the same checks and publishes the tested
  `artipod-vsix-linux-node24` artifact, which is a universal VSIX. All four
  platform/runtime jobs must pass.
- Manual workflow runs build artifacts. Selecting **verify_publisher** also
  signs in and prints the Marketplace identity ID; it never publishes.

The workflow checks the publisher, extension name, and exact tag/version match.
Only the publishing job receives an identity token. Releases are serialized;
rerunning a completed release skips an already published version.

## One-time publishing identity setup

Publishing uses Microsoft Entra federation with `azure/login` and the pinned
`vsce --azure-credential` implementation. There is no stored client secret or
personal access token. The account IDs below are stored as GitHub environment
secrets; they are identifiers, not passwords.

1. Create or select a dedicated Entra application/service principal in MIE's
   tenant. Add a federated credential for GitHub Actions with these exact values:

   | Field | Value |
   | --- | --- |
   | Issuer | `https://token.actions.githubusercontent.com` |
   | Subject | `repo:mieweb/artipod:environment:vscode-marketplace` |
   | Audience | `api://AzureADTokenExchange` |

2. In the repository's **Settings → Environments**, configure the
   `vscode-marketplace` environment. Allow deployment from the `main` branch
   (for identity verification) and tags matching `vscode-v*`. Add these secrets:

   | Secret | Value |
   | --- | --- |
   | `VSCE_AZURE_CLIENT_ID` | Application/client ID of the publishing identity |
   | `VSCE_AZURE_TENANT_ID` | Directory/tenant ID |

3. After the workflow is merged to `main`, run **Actions → VS Code extension →
   Run workflow** on `main` with **verify_publisher** selected. The identity
   check prints its Marketplace profile ID. It does not print an access token
   or publish the extension. This login uses `allow-no-subscriptions`; a
   subscription is not needed for the application/service-principal path.

4. On the [mieweb publisher management page](https://marketplace.visualstudio.com/manage/publishers/mieweb),
   add that Marketplace profile ID as a publisher member with **Contributor**
   access. Use the returned profile ID, not the Entra client ID or object ID.

See [Microsoft's Marketplace identity instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)
and [Azure Login federation setup](https://github.com/Azure/login#login-with-openid-connect-oidc-recommended).

## Publish the next update

1. Bump only the extension version and lockfile, for example:

   ```sh
   cd vscode-extension
   npm version 0.1.1 --no-git-tag-version
   ```

2. Update `vscode-extension/CHANGELOG.md`, commit the changes, and merge the
   reviewed PR after CI passes.
3. From the resulting `main` commit, push the matching extension tag:

   ```sh
   git tag vscode-v0.1.1
   git push origin vscode-v0.1.1
   ```

4. The workflow rebuilds, tests, and publishes the VSIX automatically. Check
   the workflow result and Marketplace validation status. A failed job leaves
   the previously published version available. Fix the cause and rerun when
   appropriate; use a new version for changes to an already published package.

Versions must be numeric `major.minor.patch`. This workflow intentionally
publishes to the pre-release channel, matching the initial upload. A stable
release requires changing both packaging and publishing channel flags.

Push the extension tag directly; a GitHub Release is not required. The existing
**Publish to npm** workflow responds to GitHub Release creation and is separate
from this Marketplace workflow. Extension tags are excluded from the core CLI's
derived build version.

## Build without publishing

Run the workflow manually with **verify_publisher** left unchecked and download
an `artipod-vsix-*` artifact, or build locally with Node.js 24:

```sh
npm ci
npm run build
npm run test:checkpoints
npm ci --prefix vscode-extension
npm test --prefix vscode-extension
npm run package:vsix --prefix vscode-extension -- --pre-release
```

The file is `vscode-extension/dist/artipod-VERSION.vsix`. Packaging pins README
relative links to the source commit. Installing this VSIX in stock VS Code is
the final manual smoke check when runtime behavior changes; CI's extension
tests use VS Code API doubles, not a graphical extension host.
