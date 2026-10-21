/** Protected logical registry; its writer lock is owned by the storage session. */
import type { ZenFsLike } from '@artipod/core/sandbox';
import { memoryStateMedium, type StateMedium } from './ui-state';

export const REGISTRY_PATH = '/.artipod/ui-state.json';
const PREVIOUS_PATH = '/.artipod/.ui-state.previous';

interface FileSystemBindings {
  fs: ZenFsLike;
  flushFileSystem(): Promise<void>;
}

export function registryStateMedium(bindings: () => Promise<FileSystemBindings>): StateMedium {
  const memory = memoryStateMedium();
  const read = async (fs: ZenFsLike, path: string): Promise<string | null> => {
    try { return await fs.promises.readFile(path, 'utf8') as string; }
    catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return null;
      throw error;
    }
  };
  return {
    async read(): Promise<string | null> {
      const { fs } = await bindings();
      return await read(fs, REGISTRY_PATH) ?? await read(fs, PREVIOUS_PATH);
    },
    async write(text: string): Promise<void> {
      const { fs, flushFileSystem } = await bindings();
      await fs.promises.mkdir('/.artipod', { recursive: true });
      const temporary = `/.artipod/.${crypto.randomUUID().replace(/-/g, '')}`;
      // Drain a sibling before replacing the live inode. Never overwrite-rename:
      // ZenFS removes an overwritten inode before updating its directory entry.
      await fs.promises.writeFile(temporary, text, { flag: 'wx' });
      await flushFileSystem();
      let current = await read(fs, REGISTRY_PATH);
      const previous = await read(fs, PREVIOUS_PATH);
      if (current === null && previous !== null) {
        await fs.promises.rename(PREVIOUS_PATH, REGISTRY_PATH);
        await flushFileSystem();
        current = previous;
      } else if (previous !== null) {
        // Retire the old fallback without deleting its live directory entry.
        // An interrupted cleanup can leave an opaque orphan, never a dangling
        // primary/fallback name that makes the next recovery unreadable.
        const retired = `/.artipod/.${crypto.randomUUID().replace(/-/g, '')}`;
        await fs.promises.rename(PREVIOUS_PATH, retired);
        await flushFileSystem();
        await fs.promises.unlink(retired);
        await flushFileSystem();
      }
      if (current !== null) {
        await fs.promises.rename(REGISTRY_PATH, PREVIOUS_PATH);
        await flushFileSystem();
      }
      // Same-directory renames into absent names only change the encrypted
      // directory record. A crash between them leaves the saved fallback.
      await fs.promises.rename(temporary, REGISTRY_PATH);
      await flushFileSystem();
    },
    withLock: (fn) => memory.withLock(fn),
  };
}
