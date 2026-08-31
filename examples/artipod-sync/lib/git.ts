/**
 * Re-export shim — git ops moved to @artipod/core/sandbox (plan Phase 2;
 * one release). The app-level `gitOps` singleton is gone: construct with
 * `createGitOps(() => fs)` where needed.
 */
export { createGitOps, getAuthor, setAuthor, setCorsProxy, getCorsProxy } from '@artipod/core/sandbox';
export type { GitOps, GitStatusResult, StatusEntry } from '@artipod/core/sandbox';
