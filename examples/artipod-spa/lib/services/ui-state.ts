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
  private readonly mutations = new Map<Promise<unknown>, number>();
  private readonly failures = new Map<string, { workspace?: string; error: unknown; revision: number }>();
  private revision = 0;

  constructor(private readonly medium: StateMedium) {}

  /** Drain accepted read/modify/write jobs, including jobs waiting for the mutex. */
  async flush(): Promise<void> {
    while (this.mutations.size) await Promise.allSettled([...this.mutations.keys()]);
    if (this.failures.size) throw this.failures.values().next().value?.error;
  }

  /** Successful authenticated recovery explicitly accepts loss of prior writes. */
  async acknowledgeRecovery(): Promise<void> {
    const revision = this.revision;
    await Promise.allSettled([...this.mutations].filter(([, accepted]) => accepted <= revision).map(([operation]) => operation));
    // A mutation accepted after acknowledgement began belongs to the new
    // generation and must still be reported if it fails.
    for (const [scope, failure] of this.failures) if (failure.revision <= revision) this.failures.delete(scope);
  }

  async read(): Promise<UiState> {
    const text = await this.medium.read();
    if (text === null) return { workspaces: [] };
    const state = JSON.parse(text) as UiState;
    if (!Array.isArray(state.workspaces)) throw new Error('Invalid workspace registry');
    return state;
  }

  private workspaceScopes(id: string, fields: string[]) {
    return fields.map(field => ({ key: JSON.stringify([id, field]), workspace: id }));
  }

  private mutate<T>(scopes: Array<{ key: string; workspace?: string }>, fn: (state: UiState) => T | Promise<T>, removed: string[] = []): Promise<T> {
    const revision = ++this.revision;
    const operation = Promise.resolve().then(() => this.medium.withLock(async () => {
      const state = await this.read();
      const out = await fn(state);
      await this.medium.write(JSON.stringify(state, null, 2));
      return out;
    }));
    this.mutations.set(operation, revision);
    void operation.then(() => {
      for (const scope of scopes) this.failures.delete(scope.key);
      // Removing an entry supersedes its earlier failed patches as well as
      // its presence. An unrelated entry's successful write cannot do so.
      for (const [key, failure] of this.failures) if (failure.workspace !== undefined && removed.includes(failure.workspace) && failure.revision <= revision) this.failures.delete(key);
    }, error => {
      for (const scope of scopes) this.failures.set(scope.key, { workspace: scope.workspace, error, revision });
    })
      .finally(() => this.mutations.delete(operation));
    return operation;
  }

  /** Stable per-profile LWW identity, minted on first use. */
  async actorId(): Promise<string> {
    return this.mutate([{ key: 'actor' }], (state) => {
      state.actor ??= `browser:${crypto.randomUUID().slice(0, 8)}`;
      return state.actor;
    });
  }

  async recordWorkspace(id: string, kind: 'pod' | 'blank', mode: OpenMode): Promise<void> {
    await this.mutate(this.workspaceScopes(id, ['$entry', 'id', 'kind', 'mode', 'lastOpened']), (state) => {
      const prev = state.workspaces.find((e) => e.id === id);
      state.workspaces = [
        { ...prev, id, kind, mode, lastOpened: Date.now() },
        ...state.workspaces.filter((e) => e.id !== id),
      ].slice(0, 50);
    });
  }

  async patch(id: string, patch: Partial<LocalEntry>): Promise<void> {
    const fields = Object.keys(patch);
    if (!fields.length) return;
    await this.mutate(this.workspaceScopes(id, fields), (state) => {
      const hit = state.workspaces.find((e) => e.id === id);
      if (hit) Object.assign(hit, patch);
    });
  }

  async drop(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.mutate(ids.flatMap(id => this.workspaceScopes(id, ['$entry'])), (state) => {
      state.workspaces = state.workspaces.filter((e) => !ids.includes(e.id));
    }, ids);
  }
}

/** Legacy source locator; core owns the migration. */
export { upperDirName } from '@artipod/core/storage';
