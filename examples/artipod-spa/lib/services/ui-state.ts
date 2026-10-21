/**
 * ui-state.json IO (spa-ui-plan P6: same file, same schema as the old app —
 * additive fields only until U7). Production IO uses the encrypted root;
 * one enforced vault writer owns its caches. The injected medium keeps
 * service tests independent of browser storage.
 */

export type OpenMode = 'rw' | 'cow' | 'ro';

export interface LocalEntry {
  id: string;
  kind: 'pod' | 'blank';
  lastOpened: number;
  mode?: OpenMode;
  /** Maintained by the workspace: the overlay upper holds unpushed writes. */
  hasChanges?: boolean;
  /** Maintained by the workspace (rw): the last auto-push FAILED — local is ahead of the server. */
  unsynced?: boolean;
  /** Recorded at open: this workspace's local bytes are ciphertext at rest. */
  encrypted?: boolean;
}

export interface UiState {
  actor?: string;
  workspaces: LocalEntry[];
}

/** The storage medium + mutual exclusion, injected per environment. */
export interface StateMedium {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
  /** Serializes read-modify-write across tabs; no-op mutex in node/tests. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export function memoryStateMedium(initial: string | null = null): StateMedium {
  let text = initial;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    read: async () => text,
    write: async (t) => {
      text = t;
    },
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const next = chain.then(fn);
      chain = next.catch(() => {});
      return next;
    },
  };
}

export class UiStateIO {
  constructor(private readonly medium: StateMedium) {}

  async read(): Promise<UiState> {
    const text = await this.medium.read();
    if (text === null) return { workspaces: [] };
    const state = JSON.parse(text) as UiState;
    if (!Array.isArray(state.workspaces)) throw new Error('Invalid workspace registry');
    return state;
  }

  private async mutate<T>(fn: (state: UiState) => T | Promise<T>): Promise<T> {
    return this.medium.withLock(async () => {
      const state = await this.read();
      const out = await fn(state);
      await this.medium.write(JSON.stringify(state, null, 2));
      return out;
    });
  }

  /** Stable per-profile LWW identity, minted on first use. */
  async actorId(): Promise<string> {
    return this.mutate((state) => {
      state.actor ??= `browser:${crypto.randomUUID().slice(0, 8)}`;
      return state.actor;
    });
  }

  async recordWorkspace(id: string, kind: 'pod' | 'blank', mode: OpenMode): Promise<void> {
    await this.mutate((state) => {
      const prev = state.workspaces.find((e) => e.id === id);
      state.workspaces = [
        { ...prev, id, kind, mode, lastOpened: Date.now() },
        ...state.workspaces.filter((e) => e.id !== id),
      ].slice(0, 50);
    });
  }

  async patch(id: string, patch: Partial<LocalEntry>): Promise<void> {
    await this.mutate((state) => {
      const hit = state.workspaces.find((e) => e.id === id);
      if (hit) Object.assign(hit, patch);
    });
  }

  async drop(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.mutate((state) => {
      state.workspaces = state.workspaces.filter((e) => !ids.includes(e.id));
    });
  }
}

/** Legacy source locator; core owns the migration. */
export { upperDirName } from '@artipod/core/storage';
