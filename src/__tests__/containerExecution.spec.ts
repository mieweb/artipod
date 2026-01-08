import { ArtiPod } from '../artipod';
import { ArtiMount } from '../artimount';
import { ContainerHandle } from '../containerUtils';
import { promises as fs } from 'fs';
import * as path from 'path';

describe('ArtiPod - Container Execution', () => {
  let pod: ArtiPod;
  let testContextPath: string;
  let dockerfilePath: string;
  let seccompProfilePath: string;

  beforeAll(async () => {
    // Create test context directory
    testContextPath = path.join(process.cwd(), '.test-artipod-context');
    await fs.mkdir(testContextPath, { recursive: true });
    
    // Set permissions to allow container user to write (chmod 777)
    await fs.chmod(testContextPath, 0o777);
    
    // Paths for container config
    dockerfilePath = path.join(process.cwd(), 'container', 'Dockerfile');
    seccompProfilePath = path.join(process.cwd(), 'container', 'seccomp-profiles', 'sandbox.json');
  });

  afterAll(async () => {
    // Cleanup test context
    try {
      await fs.rm(testContextPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('startContainer', () => {
    let container: ContainerHandle;

    afterEach(async () => {
      if (pod?.hasContainer()) {
        try {
          await pod.stopContainer();
        } catch {
          // Ignore cleanup errors
        }
      }
    }, 10000);

    it('should start a container', async () => {
      const mount = new ArtiMount('test', testContextPath);
      pod = new ArtiPod([mount]);
      
      container = await pod.startContainer(dockerfilePath, {
        seccompProfilePath,
      });
      
      expect(container).toBeDefined();
      expect(container.id).toBeDefined();
      expect(pod.hasContainer()).toBe(true);
    }, 10000);

    it('should start container with artipod user', async () => {
      const mount = new ArtiMount('test', testContextPath);
      pod = new ArtiPod([mount]);
      
      await pod.startContainer(dockerfilePath, {
        seccompProfilePath,
      });
      
      const result = await pod.executeCommand('whoami');
      expect(result.stdout.trim()).toBe('artipod');
      expect(result.exitCode).toBe(0);
    }, 10000);
  });

  describe('executeCommand', () => {
    beforeEach(async () => {
      const mount = new ArtiMount('test', testContextPath);
      pod = new ArtiPod([mount]);
      await pod.startContainer(dockerfilePath, {
        seccompProfilePath,
      });
    }, 10000);

    afterEach(async () => {
      if (pod?.hasContainer()) {
        try {
          await pod.stopContainer();
        } catch {
          // Ignore cleanup errors
        }
      }
    }, 10000);

    it('should execute simple echo command', async () => {
      const result = await pod.executeCommand('echo "test"');
      
      expect(result.stdout.trim()).toBe('test');
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    }, 10000);

    it('should capture stderr', async () => {
      const result = await pod.executeCommand('echo "error" >&2');
      
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe('error');
      expect(result.exitCode).toBe(0);
    }, 10000);

    it('should return non-zero exit code on failure', async () => {
      const result = await pod.executeCommand('exit 42');
      
      expect(result.exitCode).toBe(42);
    }, 10000);

    it('should execute multiple commands sequentially', async () => {
      const result1 = await pod.executeCommand('echo "first"');
      const result2 = await pod.executeCommand('echo "second"');
      
      expect(result1.stdout.trim()).toBe('first');
      expect(result2.stdout.trim()).toBe('second');
    }, 10000);

    it('should handle complex bash commands', async () => {
      const result = await pod.executeCommand(
        'for i in 1 2 3; do echo $i; done'
      );
      
      expect(result.stdout.trim()).toBe('1\n2\n3');
      expect(result.exitCode).toBe(0);
    }, 10000);

    it('should work in /context directory', async () => {
      const result = await pod.executeCommand('pwd');
      
      expect(result.stdout.trim()).toBe('/context');
      expect(result.exitCode).toBe(0);
    }, 10000);
  });

  describe('stopContainer', () => {
    it('should stop and remove container', async () => {
      const mount = new ArtiMount('test', testContextPath);
      pod = new ArtiPod([mount]);
      
      const container = await pod.startContainer(dockerfilePath, {
        seccompProfilePath,
      });
      
      expect(pod.hasContainer()).toBe(true);
      
      await pod.stopContainer();
      
      expect(pod.hasContainer()).toBe(false);
      
      // Verify container is removed
      const inspect = container.inspect.bind(container);
      await expect(inspect()).rejects.toThrow();
    }, 10000);
  });

  describe('context mount', () => {
    beforeEach(async () => {
      const mount = new ArtiMount('test', testContextPath);
      pod = new ArtiPod([mount]);
      await pod.startContainer(dockerfilePath, {
        seccompProfilePath,
      });
    }, 10000);

    afterEach(async () => {
      if (pod?.hasContainer()) {
        try {
          await pod.stopContainer();
        } catch {
          // Ignore cleanup errors
        }
      }
    }, 10000);

    it('should mount context directory', async () => {
      // Create a test file in host context
      const testFile = path.join(testContextPath, 'test.txt');
      await fs.writeFile(testFile, 'test content');
      
      // Read file from container
      const result = await pod.executeCommand('cat /context/test/test.txt');
      
      expect(result.stdout.trim()).toBe('test content');
      expect(result.exitCode).toBe(0);
      
      // Cleanup
      await fs.unlink(testFile);
    }, 10000);

    it('should allow writing to context directory', async () => {
      // Use sh -c to ensure proper shell interpretation
      const result = await pod.executeCommand(
        'sh -c "echo \\"written from container\\" > /context/test/output.txt"'
      );
      
      if (result.exitCode !== 0) {
        console.error('Command failed with exit code:', result.exitCode);
        console.error('stderr:', result.stderr);
        console.error('stdout:', result.stdout);
      }
      
      expect(result.exitCode).toBe(0);
      
      // Verify file exists on host
      const content = await fs.readFile(
        path.join(testContextPath, 'output.txt'),
        'utf-8'
      );
      expect(content.trim()).toBe('written from container');
      
      // Cleanup
      await fs.unlink(path.join(testContextPath, 'output.txt'));
    }, 10000);
  });

  describe('error handling', () => {
    it('should handle command that does not exist', async () => {
      const mount = new ArtiMount('test', testContextPath);
      pod = new ArtiPod([mount]);
      
      await pod.startContainer(dockerfilePath, {
        seccompProfilePath,
      });
      
      const result = await pod.executeCommand('nonexistentcommand');
      
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('not found');
      
      await pod.stopContainer();
    }, 10000);
  });

  describe('read-only mount', () => {
    let readonlyTestPath: string;

    beforeAll(async () => {
      // Create a separate directory for readonly tests
      readonlyTestPath = path.join(process.cwd(), '.test-artipod-readonly');
      await fs.mkdir(readonlyTestPath, { recursive: true });
      await fs.chmod(readonlyTestPath, 0o777);
      
      // Create a test file that can be read
      await fs.writeFile(path.join(readonlyTestPath, 'existing.txt'), 'readonly content');
    });

    afterAll(async () => {
      try {
        await fs.rm(readonlyTestPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    afterEach(async () => {
      if (pod?.hasContainer()) {
        try {
          await pod.stopContainer();
        } catch {
          // Ignore cleanup errors
        }
      }
    }, 10000);

    it('should mount read-only directory in container', async () => {
      const mount = new ArtiMount('readonly', readonlyTestPath, true);
      pod = new ArtiPod([mount]);
      
      await pod.startContainer(dockerfilePath, {
        seccompProfilePath,
      });
      
      // Reading should work
      const readResult = await pod.executeCommand('cat /context/readonly/existing.txt');
      expect(readResult.exitCode).toBe(0);
      expect(readResult.stdout.trim()).toBe('readonly content');
    }, 10000);

    it('should prevent writing to read-only mount in container', async () => {
      const mount = new ArtiMount('readonly', readonlyTestPath, true);
      pod = new ArtiPod([mount]);
      
      await pod.startContainer(dockerfilePath, {
        seccompProfilePath,
      });
      
      // Writing should fail
      const writeResult = await pod.executeCommand(
        'sh -c "echo test > /context/readonly/newfile.txt"'
      );
      expect(writeResult.exitCode).not.toBe(0);
    }, 10000);

    it('should allow writing to writable mount alongside read-only mount', async () => {
      const readonlyMount = new ArtiMount('readonly', readonlyTestPath, true);
      const writableMount = new ArtiMount('writable', testContextPath, false);
      pod = new ArtiPod([readonlyMount, writableMount]);
      
      await pod.startContainer(dockerfilePath, {
        seccompProfilePath,
      });
      
      // Reading from readonly should work
      const readResult = await pod.executeCommand('cat /context/readonly/existing.txt');
      expect(readResult.exitCode).toBe(0);
      expect(readResult.stdout.trim()).toBe('readonly content');
      
      // Writing to writable should work
      const writeResult = await pod.executeCommand(
        'sh -c "echo mixed-test > /context/writable/mixed.txt"'
      );
      expect(writeResult.exitCode).toBe(0);
      
      // Verify file was written on host
      const content = await fs.readFile(
        path.join(testContextPath, 'mixed.txt'),
        'utf-8'
      );
      expect(content.trim()).toBe('mixed-test');
      
      // Cleanup
      await fs.unlink(path.join(testContextPath, 'mixed.txt'));
    }, 15000);
  });
});
