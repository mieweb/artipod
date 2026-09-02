/**
 * @artipod/core/server — node-only handler factories for hosting pods
 * (sync plan Phase B, Decision D2: the example app stays thin; the heft
 * lives here). Everything is fetch-style (Request in, Response out), so
 * Next route handlers, Hono, or a raw node adapter wire it in ~3 lines.
 *
 * Rule of thumb (layer-plan §6 note 2): if a second server app would
 * copy-paste it, it's here; if it's one deployment's policy (numbers,
 * allowlist contents, tokens), it stays in the app and arrives as options.
 *
 * This subpath is mapped to `false` in the package `browser` field —
 * browser bundles must never reach it (pinned by browser-guard.test.ts).
 */

export { bearerAuth, json, type AuthHook, type PathHandler } from './common.js';
export { createArtipodApp, type ArtipodApp, type ArtipodAppOptions } from './app.js';
export { serveApp, type RunningServer, type ServeAppOptions } from './node.js';
export { withCors } from './cors.js';
export { createPodStoreHandler, type PodStoreHandlerOptions } from './pod-store-handler.js';
export {
  DEFAULT_ALLOWED_HOSTS,
  allowedHosts,
  createGitProxyHandler,
  filterRequestHeaders,
  filterResponseHeaders,
  validateProxyRequest,
  type GitProxyHandlerOptions,
  type ProxyValidation,
} from './git-proxy.js';
export {
  DEFAULT_MAX_COMMAND_LENGTH,
  createExecSessionHandler,
  execInSession,
  type ExecRequestResult,
  type ExecSessionHandlerOptions,
} from './exec-handler.js';
export { createRegistryRelayHandler, type RegistryRelayHandlerOptions } from './registry-relay.js';
export {
  ANNOTATION_ACTOR,
  ANNOTATION_MTIME,
  ANNOTATION_PARENTS,
  ANNOTATION_PATH,
  DEFAULT_PUBLISH_IGNORE,
  publishDirectory,
  materializeRef,
  type MaterializeRefResult,
  type PublishDirectoryOptions,
  type PublishResult,
} from './folder.js';
