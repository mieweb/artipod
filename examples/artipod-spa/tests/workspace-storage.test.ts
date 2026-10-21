import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceUpper, workspaceUpperPaths } from '../lib/services/workspace-storage';

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../lib/filesystem', () => ({ openFileSystemWorkspaceUpper: mocks.open }));
beforeEach(() => { mocks.open.mockReset(); });

describe('workspace storage bridge', () => {
  it('routes the ref to the owning core session and returns its upper', async () => {
    const upper = { name: 'owned upper' };
    mocks.open.mockResolvedValue(upper);
    expect(await openWorkspaceUpper({ ref: 'private-workspace:1' })).toBe(upper);
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith('private-workspace:1');
    expect(workspaceUpperPaths('private-workspace:1')).toEqual({
      directory: '/.artipod/workspace-uppers/private-workspace%3A1/tree',
      committed: '/.artipod/workspace-uppers/private-workspace%3A1/ready',
    });
  });

  it('propagates migration or access failures from core', async () => {
    const failure = new Error('EACCES: pod locked');
    mocks.open.mockRejectedValue(failure);
    await expect(openWorkspaceUpper({ ref: 'private-workspace:1' })).rejects.toBe(failure);
  });
});
