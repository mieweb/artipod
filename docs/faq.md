# Frequently asked questions

**Status:** Comparisons checked against upstream documentation on 2026-09-06. Proposed integrations are not claims of tested interoperability.

## How does artipod compare with Zarf and Skopeo?

They share an interest in portable artifacts and disconnected operation, but own different responsibilities:

| Project | Primary responsibility | Main object |
|---|---|---|
| [Zarf](https://zarf.dev/) | Package dependencies and deploy software into disconnected environments | Deployment package |
| [Skopeo](https://github.com/containers/skopeo) | Inspect, copy, verify and mirror container images | Image or image repository |
| Artipod | Open, modify, version, encrypt and synchronize durable workspaces | Writable workspace with execution attached |

Skopeo moves images. Zarf delivers and deploys software. Artipod manages the working state that users, applications and agents change.

## Is artipod an alternative to Zarf?

Not for general deployment. [Zarf packages](https://docs.zarf.dev/ref/packages/) collect container images, charts, manifests, repositories and files for disconnected installation, primarily into Kubernetes. Packages can travel as local archives, split archives or OCI artifacts. Zarf can provision a local registry and optional Git server and execute deployment actions.

Artipod instead provides mounted filesystems, writable overlays, snapshots, encrypted access and bidirectional state synchronization in browsers and Node. Application routing, scaling and production deployment belong to the embedding host; see [the execution-versus-hosting boundary](containers.md#execution-versus-application-hosting).

Our executable-application work overlaps with Zarf on immutable application distribution and verification before execution. The broader workflow adds local human or agent edits, review, republication and independently mounted subject data. That workflow is still being implemented; see the [execution plan and current gates](../model-exec-poc.md).

The projects could complement one another: Zarf could install a disconnected site's application host and supporting services, while artipod manages encrypted case workspaces across that server and users' browsers. This is an integration possibility, not a shipped integration.

## Does offline-capable mean ready for an air gap?

No. Artipod's [lazy hydration](sync.md) can list files before their contents have been downloaded. Offline operation requires the necessary bytes to be local, the runtime to be available, and authorization and key grants to remain usable.

Zarf's dependency-bundling approach is useful prior art for an explicit offline-readiness check. An artipod preflight should establish that application assets, selected data, runtime dependencies and required trust material are available before disconnection. The integrated browser application runtime still has offline approval-cache and revocation work open in the [execution plan](../model-exec-poc.md); offline application delivery is not yet fully verified.

## What supply-chain ideas are relevant from Zarf?

Zarf includes [software bills of materials (SBOMs)](https://docs.zarf.dev/ref/sboms/) in packages and supports [Cosign/Sigstore signing and offline verification material](https://docs.zarf.dev/ref/package-signing/). Evidence that travels with an artifact is useful for artipod's application-review flow.

Artipod's current execution-admission MVP uses application-specific JWS statements, not Sigstore-compatible approvals. Publisher identity and permission to execute are separate decisions. Signature interoperability and bundled SBOMs are opportunities to evaluate, not existing features of that flow.

In either system, verifying an artifact does not establish runtime confinement. Admitted artipod browser applications are trusted same-origin code with the workbench's browser authority, not isolated hostile guests. See the [execution trust decisions](../model-exec-poc.md) and [security model](security-model.md).

## How does artipod compare with Skopeo?

[Skopeo](https://github.com/containers/skopeo) is a native, daemonless CLI; most operations need no root privileges. It can inspect remote image metadata without pulling every layer and copy images between registries, local OCI layouts, archives and container-storage backends. It does not run images or maintain a writable workspace.

| Concern | Skopeo | Artipod |
|---|---|---|
| OCI operations | Image inspection, copying and repository mirroring across multiple transports | Pull/push plus filesystem realization, snapshots and history |
| File access | Image metadata and layer transport | Mounted files, indexed listings and lazy hydration |
| Editing | No working-filesystem editing model | Writable overlays, shell, editor and agent tools |
| Execution | None | Execution attached to durable pod state |
| Security | Configurable signature trust policy; image-layer encryption/decryption | Encrypted state, leased keys, offline grants and execution-admission MVP |
| Integration | Native CLI | Embeddable TypeScript library for browser and Node, with optional Docker execution |

## Is `skopeo sync` the same as artipod sync?

No. [Skopeo defines sync](https://github.com/containers/skopeo/blob/main/docs/skopeo-sync.1.md) as copying images from source to destination, for example to populate a registry in an air-gapped environment. It does not reconcile concurrent workspace edits.

If Alice and Bob edit different files while disconnected, artipod can merge those paths when their changes arrive. Concurrent edits to the same path use whole-file last-writer-wins by default, with losing versions retained in history. This is not automatic collaborative text merging; see [sync and conflict semantics](sync.md).

Skopeo can transport images containing their changes, but it does not supply that reconciliation behavior. OCI alone does not supply it either.

## Can Skopeo copy an artipod?

Skopeo is useful for ordinary container-image mirroring, but complete artipod replication needs explicit compatibility tests.

Artipod references additional blobs through annotations such as `org.artipod.layer-index` and records ancestry through `org.artipod.parents`. Our [pull implementation](../src/oci/pull.ts) explicitly fetches annotation-referenced index artifacts. Preserving an annotation's text is not the same as following its referenced digest: a generic image copy may preserve standard layers while omitting artipod indexes or history.

Custom media types, encrypted formats and separately stored approval evidence also need testing. Skopeo's image-encryption support does not imply compatibility with artipod's encryption format or key-lease protocol.

The [`skopeo copy --preserve-digests` option](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md) is useful when exact artifact identity matters: it fails if digests cannot be preserved. It does not expand the set of objects copied, so digest preservation alone does not prove a complete artipod transfer.

Use Skopeo for established image-distribution tasks; use artipod-aware synchronization for workspace state, history and reconciliation until complete interoperability is demonstrated.