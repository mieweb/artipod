/** Protected logical registry; its writer lock is owned by the storage session. */
import type { ZenFsLike } from '@artipod/core/sandbox';
import { readStorageTextFile, writeStorageTextFile } from '@artipod/core/storage';
import { memoryStateMedium, type StateMedium } from './ui-state';

export const REGISTRY_PATH = '/.artipod/ui-state.json';
const PREVIOUS_PATH = '/.artipod/.ui-state.previous';

interface FileSystemBindings {
  fs: ZenFsLike;
  flushFileSystem(): Promise<void>;
}

export function registryStateMedium(bindings: () => Promise<FileSystemBindings>): StateMedium {
  const memory = memoryStateMedium();
  const file = async () => {
    const { fs, flushFileSystem } = await bindings();
    return { zfs: fs, path: REGISTRY_PATH, previousPath: PREVIOUS_PATH, flush: flushFileSystem };
  };
  return {
    async read(): Promise<string | null> {
      return readStorageTextFile(await file());
    },
    async write(text: string): Promise<void> {
      await writeStorageTextFile(await file(), text);
    },
    withLock: (fn) => memory.withLock(fn),
  };
}
