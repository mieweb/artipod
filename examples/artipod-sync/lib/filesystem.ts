/**
 * ZenFS bootstrap.
 *
 * Async-only on purpose: the OPFS backend (WebAccess) is async-mixin based,
 * so no existsSync/mkdirSync may be used anywhere in the app.
 * ZenFS is loaded via dynamic import() so nothing Node-incompatible executes
 * during SSR; consumers gate on fsReady / await initFileSystem().
 */
export type ZenFs = (typeof import('@zenfs/core'))['fs'];

/** Live binding, assigned by initFileSystem(). Use only after init resolves. */
export let fs: ZenFs;

let initPromise: Promise<void> | null = null;

export function initFileSystem(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (!initPromise) {
    initPromise = init().catch((e) => {
      initPromise = null; // allow retry after a failed init
      throw e;
    });
  }
  return initPromise;
}

async function init(): Promise<void> {
  const core = await import('@zenfs/core');
  const { IndexedDB } = await import('@zenfs/dom');

  try {
    await core.configure({
      mounts: {
        // NB: the option is `storeName` (dom 1.2.x); the previous `name` was ignored
        '/': { backend: IndexedDB, storeName: 'browser-git-fs' },
      },
    });
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('Mount point is already in use')) {
      throw e;
    }
  }

  fs = core.fs;

  if (!(await fs.promises.exists('/repo'))) {
    await fs.promises.mkdir('/repo');
  }
  console.log('FileSystem initialized');
}
