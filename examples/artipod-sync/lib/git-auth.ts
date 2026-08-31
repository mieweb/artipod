/**
 * Re-export shim — git auth moved to @artipod/core/sandbox (plan Phase 2;
 * one release).
 */
export {
  setAuthPrompt,
  persistenceEnabled,
  setPersistence,
  setToken,
  getToken,
  clearToken,
  onAuthForUrl,
  onAuthFailureForUrl,
} from '@artipod/core/sandbox';
