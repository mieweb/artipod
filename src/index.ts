export { ArtiPod } from './artipod.js';
export { ArtiMount } from './artimount.js';
export type { PodFs, PodDirent, PodStats } from './podfs.js';
export { nodePodFs } from './nodePodFs.js';
export { PodEvents } from './events.js';
export type {
  PodEventMap,
  PodEventName,
  ExecStartEvent,
  ExecEndEvent,
  FsChangedEvent,
  EditRequestEvent,
  AgentToolCallEvent,
  ApprovalRequestEvent,
} from './events.js';
export { normalizePosix, resolvePosix, joinPosix, dirnamePosix, relativePosix } from './pathUtils.js';
// Pod manifest + realizers (plan Phase 3). realizeDocker is a pure mapping
// (no dockerode); the ZenFS realizer dynamic-imports its optional peers.
export {
  MANIFEST_FORMAT_VERSION,
  MANIFEST_MEDIA_TYPE,
  validateManifest,
  serializeManifest,
  parseManifest,
} from './manifest.js';
export type { PodManifest, PodMountDeclaration, MountSource, MountMode } from './manifest.js';
export { realizeDocker } from './realize/docker.js';
export type { DockerRealization, DockerMountRealization } from './realize/docker.js';
export { realizeZenFs, createZenFsPod } from './realize/zenfs.js';
export type { ZenFsPod, ZenFsPodOptions, ZenFsRealization, RealizedZenFsMount } from './realize/zenfs.js';
// Docker runtime VALUES live in '@artipod/core/docker' only — re-exporting
// them here would drag dockerode (native ssh2) into browser bundles.
export type {
  ArtiPodConfig,
  ArtiPodOptions,
} from './types.js';
export type {
  ContainerHandle,
  CommandResult,
  ContainerOptions,
  ContainerRuntimeInfo,
  ContainerRuntimeType,
  ContainerRuntimeMode,
} from './docker/index.js';

// Tools - vscode-copilot-chat compatible tool implementations
export * from './tools/index.js';

// Prompts - vscode-copilot-chat compatible prompt templates
export * from './prompts/index.js';
