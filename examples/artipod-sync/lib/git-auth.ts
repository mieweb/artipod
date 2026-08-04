/**
 * Git credentials for push/fetch over HTTPS.
 *
 * Tokens live OUTSIDE the sandbox filesystem (agents can read anything in
 * ZenFS — see plan §5/§8): per-origin, in memory by default, localStorage
 * only when the user opts in via `git config credential.persist true`.
 */

const LS_PREFIX = 'artipod-sync-git-token:';
const LS_PERSIST_FLAG = 'artipod-sync-git-credential-persist';

const memTokens = new Map<string, string>();

type AuthPrompt = (origin: string) => Promise<string | null>;
let promptFn: AuthPrompt | null = null;

/** Host registers how to ask the user for a PAT (e.g. a dialog in the browser). */
export function setAuthPrompt(fn: AuthPrompt | null): void {
  promptFn = fn;
}

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined';
}

export function persistenceEnabled(): boolean {
  return hasLocalStorage() && localStorage.getItem(LS_PERSIST_FLAG) === 'true';
}

export function setPersistence(enabled: boolean): void {
  if (!hasLocalStorage()) return;
  if (enabled) {
    localStorage.setItem(LS_PERSIST_FLAG, 'true');
  } else {
    localStorage.removeItem(LS_PERSIST_FLAG);
    // drop previously persisted tokens as well
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(LS_PREFIX)) localStorage.removeItem(key);
    }
  }
}

export function setToken(origin: string, token: string): void {
  memTokens.set(origin, token);
  if (persistenceEnabled()) localStorage.setItem(LS_PREFIX + origin, token);
}

export function getToken(origin: string): string | null {
  const mem = memTokens.get(origin);
  if (mem) return mem;
  if (hasLocalStorage()) {
    const stored = localStorage.getItem(LS_PREFIX + origin);
    if (stored) {
      memTokens.set(origin, stored);
      return stored;
    }
  }
  return null;
}

export function clearToken(origin: string): void {
  memTokens.delete(origin);
  if (hasLocalStorage()) localStorage.removeItem(LS_PREFIX + origin);
}

/** isomorphic-git onAuth callback for a repo URL. */
export async function onAuthForUrl(url: string): Promise<{ username: string; password: string } | { cancel: true }> {
  const origin = new URL(url).origin;
  let token = getToken(origin);
  if (!token && promptFn) {
    token = await promptFn(origin);
    if (token) setToken(origin, token);
  }
  if (!token) return { cancel: true };
  // GitHub/GitLab accept a PAT as the password with any username.
  return { username: 'x-access-token', password: token };
}

/** isomorphic-git onAuthFailure: drop the bad token so the next try re-prompts. */
export function onAuthFailureForUrl(url: string): void {
  clearToken(new URL(url).origin);
}
