# Frequently asked questions

**Status:** Git/OCI comparisons checked against upstream documentation on 2026-10-23; Zarf/Skopeo comparisons on 2026-09-06. Proposed integrations are not claims of tested interoperability.

## Why not just use Git for patient records?

Git can store and version patient records. Content addressing, history, branches, deduplication, and offline work are already strengths of Git. It also supports [partial clones](https://git-scm.com/docs/git-clone), [signed tags](https://git-scm.com/docs/git-tag), and [custom merge drivers](https://git-scm.com/docs/gitattributes#_defining_a_custom_merge_driver); [Git LFS](https://git-lfs.com/) adds separate large-file storage. None of those capabilities alone justifies choosing OCI.

Artipod targets a broader requirement: a portable workspace that applications, people, and agents can open and change in browsers and on servers. A patient workspace might contain encounter notes, structured records, imaging, PDFs, and recordings. Different applications can use authorized views of that data, while saved versions travel between devices and sites.

Building that system around Git is possible. It still needs workspace composition, selective media loading, encryption and key management, offline authorization, host-controlled mounts, and scoped agent access. Artipod supplies mechanisms for those concerns; OCI supplies part of the packaging and distribution foundation. Browser apps remain trusted same-origin code; see the [security model](security-model.md). The [PatientPod composition example](../README.md#pod-kinds-data-applications-and-agents) remains illustrative rather than a complete clinical application.

For a concrete lifecycle, the [dossier pattern](dossier.md) maps a patient to a repository, encounters to separate draft workstreams, completed encounters to server-enforced sealed versions, and corrections to linked amendments. Git branches and protected tags could support a similar workflow. The value is implementing and enforcing the workflow, rather than simply having a history of files.

If the requirement is versioned text or JSON with a suitable application around it, Git is a reasonable choice. Compare the complete systems and their operational costs. Neither Git nor OCI supplies clinical validation, clinician attestation, comprehensive access auditing, or safe reconciliation of conflicting chart edits by itself. Artipod's default same-file merge is whole-file last-writer-wins; retaining the losing version in history does not resolve the clinical disagreement. See [sync semantics](sync.md#what-lww-means-for-your-files).

## What does OCI add beyond Git?

**OCI provides a standard for packaging and distributing layered artifacts.** Its value is the format, protocol, and infrastructure Artipod can reuse. Git could underpin equivalent behavior, but that behavior still has to be implemented or integrated.

- **Layered filesystem packaging.** The [OCI layer specification](https://github.com/opencontainers/image-spec/blob/main/layer.md) defines filesystem additions, replacements, deletions, and metadata. Artipod uses immutable layers plus a writable overlay to assemble workspaces and capture changes. Git has snapshots and history; overlay composition is additional machinery around Git.
- **Independent blob distribution.** The [OCI distribution specification](https://github.com/opencontainers/distribution-spec/blob/main/spec.md) defines digest-addressed blob access, resumable uploads and downloads, and upload deduplication. This is a useful foundation for large media and opaque encrypted content, with existing registry implementations. Git can also store binary data; OCI's advantage here is adopting an artifact distribution protocol, rather than an inability of Git to represent the bytes.
- **Typed manifests and associated artifacts.** The [OCI manifest specification](https://github.com/opencontainers/image-spec/blob/main/manifest.md) describes components by media type, size, and digest. Its subject relationship and the registry referrers API support attaching separate artifacts to an exact version, such as signatures or processing metadata, without changing the original. These are integration building blocks, not a claim that every Artipod attachment already interoperates with external tooling.

You could store a container's filesystem in Git too; standardized image packaging and registry delivery still have practical value. The same argument applies to a durable data workspace. OCI is worthwhile when its layering and distribution infrastructure save implementation and operational work; it is not automatically a better choice for every collection of files.

Keep the boundary clear: Artipod's file indexes and lazy hydration, history annotations, merge policy, encryption, key leases, and mount authorization are additional Artipod mechanisms. OCI alone does not supply them. Complete replication by generic OCI tools also needs compatibility testing: annotation-referenced indexes and history may be omitted even when ordinary layers copy successfully. See [Can Skopeo copy an artipod?](#can-skopeo-copy-an-artipod).

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
