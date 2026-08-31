/**
 * @artipod/core/host — headless UI controllers (plan §3): framework-free
 * logic for terminals, editors and file trees. Apps keep thin shells
 * (xterm, Monaco, react-complex-tree); tests use fakes. Import-safe in Node.
 */
export { TerminalSession, toCrLf, commonPrefix } from './terminal-session.js';
export type { TerminalIO, TerminalSessionOptions } from './terminal-session.js';
export { FileBuffer, languageForPath } from './file-buffer.js';
export type { FileBufferOptions, FileBufferListener } from './file-buffer.js';
export { TreeSource, TREE_ROOT_ID } from './tree-source.js';
export type { TreeItemData, TreeSourceOptions } from './tree-source.js';
export { PodEvents } from '../events.js';
export type {
  PodEventMap,
  PodEventName,
  ExecStartEvent,
  ExecEndEvent,
  FsChangedEvent,
  EditRequestEvent,
  AgentToolCallEvent,
  ApprovalRequestEvent,
} from '../events.js';
