/**
 * ui-state.json IO (spa-ui-plan P6: same file, same schema as the old app —
 * additive fields only until U7). On OPFS, reads/writes go through RAW
 * handles (each tab's ZenFS caches independently; raw handles always see the
 * latest bytes) under a Web Lock with an exclusive writable as the hard
 * backstop. The medium is injected so node tests run against memory.
 */

export type OpenMode = 'rw' | 'cow';

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

/** Raw-OPFS medium (browser): artipod-fs/.artipod/ui-state.json + Web Lock. */
export function opfsStateMedium(): StateMedium {
  return {
    async read(): Promise<string | null> {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await (await root.getDirectoryHandle('artipod-fs')).getDirectoryHandle('.artipod');
        const file = await (await dir.getFileHandle('ui-state.json')).getFile();
        return await file.text();
      } catch {
        return null;
      }
    },
    async write(text: string): Promise<void> {
      const root = await navigator.storage.getDirectory();
      const fsDir = await root.getDirectoryHandle('artipod-fs', { create: true });
      const dir = await fsDir.getDirectoryHandle('.artipod', { create: true });
      const handle = await dir.getFileHandle('ui-state.json', { create: true });
      // Exclusive writable: a racing tab's write THROWS instead of silently
      // clobbering. Older engines ignore/reject the option — retry plain.
      let w: FileSystemWritableFileStream;
      try {
        w = await (
          handle as { createWritable(o?: { mode?: string }): Promise<FileSystemWritableFileStream> }
        ).createWritable({ mode: 'exclusive' });
      } catch {
        w = await handle.createWritable();
      }
      await w.write(text);
      await w.close();
    },
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
      try {
        return await navigator.locks.request('artipod-ui-state', fn);
      } catch {
        return fn();
      }
    },
  };
}

export class UiStateIO {
  constructor(private readonly medium: StateMedium) {}

  async read(): Promise<UiState> {
    const text = await this.medium.read();
    if (text === null) return { workspaces: [] };
    try {
      return JSON.parse(text) as UiState;
    } catch {
      return { workspaces: [] };
    }
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

/** Opaque upper-dir name for broker-mode block stores — hides WHICH refs have local forks. */
export async function upperDirName(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`artipod-upper:${id}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}
