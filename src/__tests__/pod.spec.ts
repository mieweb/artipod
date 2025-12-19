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
    it('should create a new ArtiPod instance', () => {
      const pod = new ArtiPod();
      expect(pod).toBeInstanceOf(ArtiPod);
    });

    it('should create pod with empty mounts', () => {
      const pod = new ArtiPod([]);
      expect(pod.getMountNames()).toEqual([]);
    });
  });

  describe('mount management', () => {
    it('should add a mount', async () => {
      const pod = new ArtiPod();
      const mountPath = path.join(testDir, 'mount1');
      await fs.mkdir(mountPath, { recursive: true });
      const mount = new ArtiMount('test-mount', mountPath);
      await mount.initialize();
      
      pod.addMount(mount);
      expect(pod.getMount('test-mount')).toBe(mount);
    });

    it('should remove a mount', async () => {
      const pod = new ArtiPod();
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
      const pod = new ArtiPod();
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
      const pod = new ArtiPod();
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
  });
});
