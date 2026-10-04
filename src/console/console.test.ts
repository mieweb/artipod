/**
 * Console module contract: SSR-safe no-op without a DOM (docs/console.md).
 * The DOM rendering itself is exercised in browser consumers; here we pin
 * that importing and installing in Node never throws and never renders.
 */
import { describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { createSandbox } from '../sandbox/index.js';
import { installConsole } from './index.js';

describe('installConsole (no DOM)', () => {
  it('returns a no-op handle in Node/SSR', async () => {
    try {
      umount('/');
    } catch {
      // first run
    }
    await configure({ mounts: { '/': InMemory } });
    await zfs.promises.mkdir('/repo');
    const sandbox = createSandbox({ zfs });

    const handle = installConsole({ sandbox });
    expect(handle.isOpen).toBe(false);
    // all methods are safe no-ops
    handle.toggle();
    handle.show();
    handle.hide();
    handle.dispose();
    expect(handle.isOpen).toBe(false);
  });
});
