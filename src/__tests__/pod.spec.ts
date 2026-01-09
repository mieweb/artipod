import { ArtiPod } from '../artipod';
import { ArtiMount } from '../artimount';
import { promises as fs } from 'fs';
import * as path from 'path';

describe('ArtiPod', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(process.cwd(), 'test-pods', `test-${Date.now()}`);
  });

  afterEach(async () => {
    try {
      await fs.rm(path.join(process.cwd(), 'test-pods'), { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create a new ArtiPod instance without main mount', () => {
      const pod = new ArtiPod({ useMainMount: false });
      expect(pod).toBeInstanceOf(ArtiPod);
    });

    it('should create pod with empty mounts when useMainMount is false', () => {
      const pod = new ArtiPod({ useMainMount: false, mounts: [] });
      expect(pod.getMountNames()).toEqual([]);
    });

    it('should generate a random ID if not provided', () => {
      const pod1 = new ArtiPod({ useMainMount: false });
      const pod2 = new ArtiPod({ useMainMount: false });
      
      expect(pod1.getId()).toBeDefined();
      expect(pod2.getId()).toBeDefined();
      expect(pod1.getId()).not.toBe(pod2.getId());
      expect(pod1.getId()).toHaveLength(32); // 16 bytes = 32 hex chars
    });

    it('should use provided ID', () => {
      const customId = 'my-custom-pod-id';
      const pod = new ArtiPod({ id: customId, useMainMount: false });
      
      expect(pod.getId()).toBe(customId);
    });

    it('should throw error if workspaceDir not provided and useMainMount is true', () => {
      expect(() => {
        new ArtiPod();
      }).toThrow('workspaceDir is required unless useMainMount is false');
    });

    it('should not throw error if workspaceDir provided', () => {
      expect(() => {
        new ArtiPod({ workspaceDir: testDir });
      }).not.toThrow();
    });

    it('should reject duplicate mount names in constructor', async () => {
      const mount1Path = path.join(testDir, 'mount1');
      const mount2Path = path.join(testDir, 'mount2');
      await fs.mkdir(mount1Path, { recursive: true });
      await fs.mkdir(mount2Path, { recursive: true });
      const mount1 = new ArtiMount('duplicate', mount1Path);
      const mount2 = new ArtiMount('duplicate', mount2Path);
      
      expect(() => {
        new ArtiPod({ useMainMount: false, mounts: [mount1, mount2] });
      }).toThrow('Duplicate mount name: duplicate');
    });

    it('should reject "main" mount name in constructor when useMainMount is true', async () => {
      const mountPath = path.join(testDir, 'mount1');
      await fs.mkdir(mountPath, { recursive: true });
      const mount = new ArtiMount('main', mountPath);
      
      expect(() => {
        new ArtiPod({ workspaceDir: testDir, mounts: [mount] });
      }).toThrow("Cannot provide a mount named 'main' when useMainMount is true");
    });

    it('should allow "main" mount name in constructor when useMainMount is false', async () => {
      const mountPath = path.join(testDir, 'mount1');
      await fs.mkdir(mountPath, { recursive: true });
      const mount = new ArtiMount('main', mountPath);
      
      expect(() => {
        new ArtiPod({ useMainMount: false, mounts: [mount] });
      }).not.toThrow();
    });
  });

  describe('mount management', () => {
    it('should add a mount', async () => {
      const pod = new ArtiPod({ useMainMount: false });
      const mountPath = path.join(testDir, 'mount1');
      await fs.mkdir(mountPath, { recursive: true });
      const mount = new ArtiMount('test-mount', mountPath);
      await mount.initialize();
      
      pod.addMount(mount);
      expect(pod.getMount('test-mount')).toBe(mount);
    });

    it('should remove a mount', async () => {
      const pod = new ArtiPod({ useMainMount: false });
      const mountPath = path.join(testDir, 'mount1');
      await fs.mkdir(mountPath, { recursive: true });
      const mount = new ArtiMount('test-mount', mountPath);
      await mount.initialize();
      
      pod.addMount(mount);
      const removed = pod.removeMount('test-mount');
      
      expect(removed).toBe(true);
      expect(pod.getMount('test-mount')).toBeUndefined();
    });

    it('should list all mount names', async () => {
      const pod = new ArtiPod({ useMainMount: false });
      const mount1Path = path.join(testDir, 'mount1');
      const mount2Path = path.join(testDir, 'mount2');
      await fs.mkdir(mount1Path, { recursive: true });
      await fs.mkdir(mount2Path, { recursive: true });
      const mount1 = new ArtiMount('mount1', mount1Path);
      const mount2 = new ArtiMount('mount2', mount2Path);
      await mount1.initialize();
      await mount2.initialize();
      
      pod.addMount(mount1);
      pod.addMount(mount2);
      
      const names = pod.getMountNames();
      expect(names).toContain('mount1');
      expect(names).toContain('mount2');
      expect(names).toHaveLength(2);
    });

    it('should get all mounts', async () => {
      const pod = new ArtiPod({ useMainMount: false });
      const mount1Path = path.join(testDir, 'mount1');
      const mount2Path = path.join(testDir, 'mount2');
      await fs.mkdir(mount1Path, { recursive: true });
      await fs.mkdir(mount2Path, { recursive: true });
      const mount1 = new ArtiMount('mount1', mount1Path);
      const mount2 = new ArtiMount('mount2', mount2Path);
      await mount1.initialize();
      await mount2.initialize();
      
      pod.addMount(mount1);
      pod.addMount(mount2);
      
      const mounts = pod.getMounts();
      expect(mounts).toContain(mount1);
      expect(mounts).toContain(mount2);
      expect(mounts).toHaveLength(2);
    });

    it('should reject "main" mount name via addMount when useMainMount is true', async () => {
      const pod = new ArtiPod({ workspaceDir: testDir });
      const mountPath = path.join(testDir, 'mount1');
      await fs.mkdir(mountPath, { recursive: true });
      const mount = new ArtiMount('main', mountPath);
      
      expect(() => {
        pod.addMount(mount);
      }).toThrow("Mount name 'main' is reserved for the auto-generated main mount");
    });

    it('should allow "main" mount name via addMount when useMainMount is false', async () => {
      const pod = new ArtiPod({ useMainMount: false });
      const mountPath = path.join(testDir, 'mount1');
      await fs.mkdir(mountPath, { recursive: true });
      const mount = new ArtiMount('main', mountPath);
      await mount.initialize();
      
      expect(() => {
        pod.addMount(mount);
      }).not.toThrow();
      expect(pod.getMount('main')).toBe(mount);
    });
  });

  describe('initialize', () => {
    it('should create and initialize main mount automatically', async () => {
      const pod = new ArtiPod({ workspaceDir: testDir });
      await pod.initialize();
      
      const mainMount = pod.getMount('main');
      expect(mainMount).toBeDefined();
      expect(mainMount?.getName()).toBe('main');
      expect(mainMount?.isReadOnly()).toBe(false);
      
      // Verify directory was created
      const mainMountPath = path.join(testDir, `artipod-${pod.getId()}`);
      const stats = await fs.stat(mainMountPath);
      expect(stats.isDirectory()).toBe(true);
    });

    it('should not create main mount when useMainMount is false', async () => {
      const pod = new ArtiPod({ useMainMount: false });
      await pod.initialize();
      
      expect(pod.getMount('main')).toBeUndefined();
      expect(pod.getMountNames()).toHaveLength(0);
    });

    it('should use provided ID for main mount directory', async () => {
      const customId = 'my-test-pod';
      const pod = new ArtiPod({ id: customId, workspaceDir: testDir });
      await pod.initialize();
      
      const mainMountPath = path.join(testDir, `artipod-${customId}`);
      const stats = await fs.stat(mainMountPath);
      expect(stats.isDirectory()).toBe(true);
    });

    it('should not error if main mount directory already exists', async () => {
      const customId = 'existing-pod';
      const mainMountPath = path.join(testDir, `artipod-${customId}`);
      await fs.mkdir(mainMountPath, { recursive: true });
      
      const pod = new ArtiPod({ id: customId, workspaceDir: testDir });
      await expect(pod.initialize()).resolves.not.toThrow();
      
      const mainMount = pod.getMount('main');
      expect(mainMount).toBeDefined();
    });

    it('should initialize user-provided mounts', async () => {
      const mount1Path = path.join(testDir, 'mount1');
      const mount2Path = path.join(testDir, 'mount2');
      await fs.mkdir(mount1Path, { recursive: true });
      await fs.mkdir(mount2Path, { recursive: true });
      const mount1 = new ArtiMount('mount1', mount1Path);
      const mount2 = new ArtiMount('mount2', mount2Path);
      
      const pod = new ArtiPod({ 
        workspaceDir: testDir,
        mounts: [mount1, mount2]
      });
      await pod.initialize();
      
      // Should have main mount plus the two user mounts
      expect(pod.getMountNames()).toHaveLength(3);
      expect(pod.getMountNames()).toContain('main');
      expect(pod.getMountNames()).toContain('mount1');
      expect(pod.getMountNames()).toContain('mount2');
    });

    it('should be idempotent - calling initialize multiple times should be safe', async () => {
      const pod = new ArtiPod({ workspaceDir: testDir });
      
      await pod.initialize();
      await pod.initialize();
      await pod.initialize();
      
      // Should still only have one main mount
      expect(pod.getMountNames()).toHaveLength(1);
      expect(pod.getMount('main')).toBeDefined();
    });
  });

  describe('cleanupMainMount', () => {
    it('should remove main mount and delete directory', async () => {
      const pod = new ArtiPod({ workspaceDir: testDir });
      await pod.initialize();
      
      const mainMountPath = path.join(testDir, `artipod-${pod.getId()}`);
      
      // Verify it exists before cleanup
      const stats = await fs.stat(mainMountPath);
      expect(stats.isDirectory()).toBe(true);
      
      await pod.cleanupMainMount();
      
      // Verify mount was removed
      expect(pod.getMount('main')).toBeUndefined();
      
      // Verify directory was deleted
      await expect(fs.stat(mainMountPath)).rejects.toThrow();
    });

    it('should be safe to call when no main mount exists', async () => {
      const pod = new ArtiPod({ useMainMount: false });
      await pod.initialize();
      
      await expect(pod.cleanupMainMount()).resolves.not.toThrow();
    });

    it('should be safe to call when main mount was manually removed', async () => {
      const pod = new ArtiPod({ workspaceDir: testDir });
      await pod.initialize();
      
      pod.removeMount('main');
      
      await expect(pod.cleanupMainMount()).resolves.not.toThrow();
    });
  });
});
