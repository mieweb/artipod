/**
 * Identity — what a shell is a shell *of*. One record drives `hostname`,
 * `uname`, `$HOSTNAME`/`$ARTIPOD_*`, the prompt, the motd, and its `/proc`
 * projection (`/proc/sys/kernel/*`, Linux layout), so a user can always tell
 * a catalog console from a pod workspace from a server exec session.
 */
import type { ProcProvider } from './registry.js';

export interface SandboxIdentity {
  /** `catalog` (no pod), `workspace` (a pod session), `pod` (artipod run), `server` (an exec session), … */
  kind: string;
  /** Human label: the ref, workspace id, pod id, or session id. */
  name: string;
  /** e.g. `cow` / `rw` / `ro` for workspaces; `kept` / `--rm` for CLI pods. */
  mode?: string;
  /** The artipod version string shown by `uname -r` and the banner. */
  version?: string;
}

/** `samples/lifecycle:_3` → `samples_lifecycle__3`: the hostname form of a name. */
export const hostnameOf = (identity: SandboxIdentity): string =>
  identity.kind === 'catalog' ? 'catalog' : identity.name.replace(/[^a-zA-Z0-9._-]+/g, '_');

/** The one-line "where am I" the banner and `uname -o` share. */
export function describeIdentity(identity: SandboxIdentity): string {
  switch (identity.kind) {
    case 'catalog': return 'catalog console — no pod open; the whole browser filesystem';
    case 'workspace': return `workspace ${identity.name}${identity.mode ? ` (${identity.mode})` : ''} — a pod session`;
    case 'pod': return `pod ${identity.name}${identity.mode ? ` (${identity.mode})` : ''} — artipod run on this machine`;
    case 'server': return `server exec session ${identity.name}`;
    default: return `${identity.kind} ${identity.name}${identity.mode ? ` (${identity.mode})` : ''}`;
  }
}

/** `/proc/sys/kernel/{hostname,ostype,osrelease,version}` — what `uname` prints, as files. */
export function makeIdentityProvider(identity: SandboxIdentity): ProcProvider {
  return {
    name: 'sys',
    description: 'Identity: which shell this is (uname / hostname)',
    mode: 'ro',
    read: async () => ({
      'kernel/hostname': `${hostnameOf(identity)}\n`,
      'kernel/ostype': 'artipod\n',
      'kernel/osrelease': `${identity.version ?? 'unknown'}\n`,
      'kernel/version': `${describeIdentity(identity)}\n`,
      'kernel/identity.json': `${JSON.stringify(identity)}\n`,
    }),
  };
}
