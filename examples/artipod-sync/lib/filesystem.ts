let fs: any;
let configure: any;

if (typeof window !== 'undefined') {
  const ZenFS = require('@zenfs/core');
  fs = ZenFS.fs;
  configure = ZenFS.configure;
} else {
  fs = {};
  configure = async () => {};
}

let initialized = false;

export async function initFileSystem() {
  if (initialized) return;

  if (typeof window === 'undefined') {
    return;
  }

  try {
    const { IndexedDB } = await import('@zenfs/dom');
    try {
      await configure({
        mounts: {
          '/': { backend: IndexedDB, name: 'browser-git-fs' },
        },
      });
    } catch (e: any) {
      if (e.message && e.message.includes('Mount point is already in use')) {
        console.log('FileSystem already configured');
      } else {
        throw e;
      }
    }
    
    // Create /repo directory if it doesn't exist
    if (!fs.existsSync('/repo')) {
      fs.mkdirSync('/repo');
    }
    
    initialized = true;
    console.log('FileSystem initialized');
  } catch (error) {
    console.error('Failed to initialize FileSystem:', error);
    throw error;
  }
}

export { fs };
