import { ArtiMount } from '../artimount.js';
import { promises as fs } from 'fs';
import * as path from 'path';

describe('ArtiMount', () => {
  let testDir: string;
  let mount: ArtiMount;

  beforeEach(async () => {
    // Create unique test directory
    testDir = path.join(process.cwd(), 'test-mounts', `test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    mount = new ArtiMount('test-mount', testDir);
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should initialize mount in existing directory', async () => {
      await mount.initialize();

      // Check directory exists
      const dirStats = await fs.stat(testDir);
      expect(dirStats.isDirectory()).toBe(true);
    });

    it('should throw error for non-existent directory', async () => {
      const badMount = new ArtiMount('bad-mount', '/nonexistent/path');
      await expect(badMount.initialize()).rejects.toThrow('does not exist');
    });
  });

  describe('file operations', () => {
    beforeEach(async () => {
      await mount.initialize();
    });

    it('should write and read a file', async () => {
      const content = 'Hello, world!';
      await mount.write('test.txt', content);

      const readContent = await mount.read('test.txt');
      expect(readContent).toBe(content);
    });

    it('should write files in subdirectories', async () => {
      const content = 'Nested file content';
      await mount.write('subdir/nested.txt', content);

      const readContent = await mount.read('subdir/nested.txt');
      expect(readContent).toBe(content);
    });

    it('should throw error when reading non-existent file', async () => {
      await expect(mount.read('nonexistent.txt')).rejects.toThrow('File not found');
    });

    it('should read specific line range from file', async () => {
      const content = 'line 1\nline 2\nline 3\nline 4\nline 5';
      await mount.write('multiline.txt', content);

      // Read lines 2-4 (1-indexed, inclusive)
      const partial = await mount.read('multiline.txt', 2, 4);
      expect(partial).toBe('line 2\nline 3\nline 4');
    });

    it('should read from start line to end of file', async () => {
      const content = 'line 1\nline 2\nline 3\nline 4\nline 5';
      await mount.write('multiline.txt', content);

      const partial = await mount.read('multiline.txt', 3);
      expect(partial).toBe('line 3\nline 4\nline 5');
    });

    it('should read from beginning to end line', async () => {
      const content = 'line 1\nline 2\nline 3\nline 4\nline 5';
      await mount.write('multiline.txt', content);

      const partial = await mount.read('multiline.txt', undefined, 3);
      expect(partial).toBe('line 1\nline 2\nline 3');
    });

    it('should handle platform-agnostic line endings', async () => {
      // Test with CRLF (Windows-style) line endings
      const content = 'line 1\r\nline 2\r\nline 3\r\nline 4';
      await mount.write('windows.txt', content);

      const partial = await mount.read('windows.txt', 2, 3);
      expect(partial).toBe('line 2\nline 3');
    });

    it('should throw error when start line exceeds file length', async () => {
      const content = 'line 1\nline 2\nline 3';
      await mount.write('short.txt', content);

      await expect(mount.read('short.txt', 10, 12)).rejects.toThrow('exceeds file length');
    });

    it('should prevent path traversal outside mount', async () => {
      await expect(mount.write('../outside.txt', 'bad')).rejects.toThrow(
        'outside mount root'
      );
    });
  });

  describe('list files', () => {
    beforeEach(async () => {
      await mount.initialize();
    });

    it('should list all files in mount', async () => {
      await mount.write('file1.txt', 'content1');
      await mount.write('file2.txt', 'content2');
      await mount.write('subdir/file3.txt', 'content3');

      const files = await mount.list();
      const paths = files.map(f => f.path);
      expect(paths).toContain('file1.txt');
      expect(paths).toContain('file2.txt');
      expect(paths).toContain(path.join('subdir', 'file3.txt'));
      // Verify sizes are present
      expect(files.every(f => typeof f.size === 'number')).toBe(true);
    });

    it('should list files in subdirectory', async () => {
      await mount.write('root.txt', 'root');
      await mount.write('subdir/file1.txt', 'sub1');
      await mount.write('subdir/file2.txt', 'sub2');

      const files = await mount.list('subdir');
      const paths = files.map(f => f.path);
      expect(paths).toContain(path.join('subdir', 'file1.txt'));
      expect(paths).toContain(path.join('subdir', 'file2.txt'));
      expect(paths).not.toContain('root.txt');
      // Verify sizes are present
      expect(files.every(f => typeof f.size === 'number')).toBe(true);
    });

    it('should return empty array for empty mount', async () => {
      const files = await mount.list();
      expect(files).toEqual([]);
    });
  });

  describe('README management', () => {
    beforeEach(async () => {
      await mount.initialize();
    });

    it('should return empty array when no README exists', async () => {
      const content = await mount.getReadmeContents();
      expect(content).toEqual([]);
    });

    it('should read README.md', async () => {
      await mount.write('README.md', '# Test Mount\n\nThis is a test.');
      
      const content = await mount.getReadmeContents();
      expect(content).toEqual(['# Test Mount\n\nThis is a test.']);
    });

    it('should read readme.md (lowercase)', async () => {
      await mount.write('readme.md', '# Lowercase README');
      
      const content = await mount.getReadmeContents();
      expect(content).toEqual(['# Lowercase README']);
    });

    it('should handle both README.md and readme.md correctly', async () => {
      // Note: On case-insensitive file systems, these will be the same file
      // This test verifies the code handles both names correctly
      await mount.write('README.md', '# Main README');
      
      const content = await mount.getReadmeContents();
      expect(content).toEqual(['# Main README']);
    });

    it('should only read READMEs from root directory', async () => {
      await mount.write('README.md', '# Root README');
      await mount.write('subdir/README.md', '# Subdir README');
      
      const content = await mount.getReadmeContents();
      expect(content).toEqual(['# Root README']);
      expect(content.join('')).not.toContain('Subdir');
    });
  });

  describe('mount properties', () => {
    it('should return mount name', () => {
      expect(mount.getName()).toBe('test-mount');
    });

    it('should return root path', () => {
      expect(mount.getRootPath()).toBe(testDir);
    });

    it('should return false for isReadOnly by default', () => {
      expect(mount.isReadOnly()).toBe(false);
    });

    it('should return true for isReadOnly when created as readonly', () => {
      const readonlyMount = new ArtiMount('readonly-mount', testDir, true);
      expect(readonlyMount.isReadOnly()).toBe(true);
    });
  });

  describe('read-only mount', () => {
    let readonlyMount: ArtiMount;

    beforeEach(async () => {
      readonlyMount = new ArtiMount('readonly-mount', testDir, true);
      await readonlyMount.initialize();
    });

    it('should throw error when writing to read-only mount', async () => {
      await expect(readonlyMount.write('test.txt', 'content')).rejects.toThrow(
        "Cannot write to read-only mount 'readonly-mount'"
      );
    });

    it('should throw error when creating folder in read-only mount', async () => {
      await expect(readonlyMount.createFolder('subdir')).rejects.toThrow(
        "Cannot create folder in read-only mount 'readonly-mount'"
      );
    });

    it('should allow reading from read-only mount', async () => {
      // Create a file using a writable mount first
      const writableMount = new ArtiMount('writable', testDir, false);
      await writableMount.write('readable.txt', 'test content');

      // Read should work on readonly mount
      const content = await readonlyMount.read('readable.txt');
      expect(content).toBe('test content');
    });

    it('should allow listing files in read-only mount', async () => {
      // Create files using a writable mount
      const writableMount = new ArtiMount('writable', testDir, false);
      await writableMount.write('file1.txt', 'content1');
      await writableMount.write('file2.txt', 'content2');

      // List should work on readonly mount
      const files = await readonlyMount.list();
      const paths = files.map(f => f.path);
      expect(paths).toContain('file1.txt');
      expect(paths).toContain('file2.txt');
    });
  });
});
