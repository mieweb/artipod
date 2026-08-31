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
