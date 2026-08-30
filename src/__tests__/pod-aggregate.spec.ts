import { ArtiPod } from '../artipod.js';
import { ArtiMount } from '../artimount.js';
import { promises as fs } from 'fs';
import * as path from 'path';

describe('ArtiPod - Aggregation and Prompt Building', () => {
  let testDir: string;
  let mount1: ArtiMount;
  let mount2: ArtiMount;
  let mount3: ArtiMount;

  beforeEach(async () => {
    testDir = path.join(process.cwd(), 'test-pod-agg', `test-${Date.now()}`);
    
    mount1 = new ArtiMount('docs', path.join(testDir, 'docs'));
    mount2 = new ArtiMount('code', path.join(testDir, 'code'));
    mount3 = new ArtiMount('assets', path.join(testDir, 'assets'));

    // Create mount directories
    await fs.mkdir(path.join(testDir, 'docs'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'code'), { recursive: true });
    await fs.mkdir(path.join(testDir, 'assets'), { recursive: true });

    await mount1.initialize();
    await mount2.initialize();
    await mount3.initialize();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('should create empty pod', () => {
      const pod = new ArtiPod({ useMainMount: false });
      expect(pod.getMountNames()).toEqual([]);
    });

    it('should initialize with mounts', async () => {
      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1, mount2] });
      expect(pod.getMountNames()).toEqual(['docs', 'code']);
    });

    it('should throw on duplicate mount names', () => {
      const duplicate = new ArtiMount('docs', path.join(testDir, 'docs2'));
      expect(() => new ArtiPod({ useMainMount: false, mounts: [mount1, duplicate] })).toThrow('Duplicate mount name: docs');
    });
  });

  describe('mount management', () => {
    it('should add mount', () => {
      const pod = new ArtiPod({ useMainMount: false });
      pod.addMount(mount1);
      expect(pod.getMount('docs')).toBe(mount1);
    });

    it('should throw on adding duplicate mount name', () => {
      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const duplicate = new ArtiMount('docs', path.join(testDir, 'other'));
      expect(() => pod.addMount(duplicate)).toThrow("Mount with name 'docs' already exists");
    });

    it('should throw on invalid mount name with XML characters', () => {
      const pod = new ArtiPod({ useMainMount: false });
      const invalidMount = new ArtiMount('<invalid>', path.join(testDir, 'invalid'));
      expect(() => pod.addMount(invalidMount)).toThrow('contains invalid characters');
    });

    it('should list mounts', () => {
      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1, mount2, mount3] });
      const names = pod.getMountNames();
      expect(names).toContain('docs');
      expect(names).toContain('code');
      expect(names).toContain('assets');
    });
  });

  describe('buildPrompt - basic aggregation', () => {
    it('should aggregate README content from multiple mounts', async () => {
      await mount1.write('README.md', '# Documentation\n\nThis mount contains docs.');
      await mount2.write('README.md', '# Code\n\nThis mount contains code.');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1, mount2] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('<context>');
      expect(prompt).toContain('<dataSource>');
      expect(prompt).toContain('<name>docs</name>');
      expect(prompt).toContain('<readme>');
      expect(prompt).toContain('# Documentation');
      expect(prompt).toContain('This mount contains docs.');
      expect(prompt).toContain('</readme>');
      expect(prompt).toContain('</dataSource>');

      expect(prompt).toContain('<name>code</name>');
      expect(prompt).toContain('# Code');
      expect(prompt).toContain('This mount contains code.');
      expect(prompt).toContain('</context>');
    });

    it('should format with blank lines between mounts', async () => {
      await mount1.write('README.md', 'Docs content');
      await mount2.write('README.md', 'Code content');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1, mount2] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toMatch(/<\/dataSource>\n\n<dataSource>/);
    });

    it('should handle empty pod', async () => {
      const pod = new ArtiPod({ useMainMount: false });
      const prompt = await pod.buildPrompt();
      expect(prompt).toBe('');
    });

    it('should include mount with empty README', async () => {
      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();
      expect(prompt).toContain('<dataSource>');
      expect(prompt).toContain('<name>docs</name>');
      expect(prompt).toContain('</dataSource>');
    });

    it('should include mount even when README is missing', async () => {
      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();
      
      expect(prompt).toContain('<dataSource>');
      expect(prompt).toContain('<name>docs</name>');
      expect(prompt).toContain('</dataSource>');
    });
  });

  describe('buildPrompt - README variants', () => {
    it('should read README.md', async () => {
      await mount1.write('README.md', '# Upper case README');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('# Upper case README');
    });

    it('should read readme.md', async () => {
      await mount1.write('readme.md', '# Lower case README');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('# Lower case README');
    });

    it('should read README from mount', async () => {
      // Note: On case-insensitive file systems (macOS default), README.md and readme.md are the same file
      await mount1.write('README.md', '# Main README');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('# Main README');
    });
  });

  describe('buildPrompt - maxSize truncation', () => {
    it('should truncate prompt when exceeding maxSize', async () => {
      const longContent = 'x'.repeat(1000);
      await mount1.write('README.md', longContent);

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt({ maxSize: 100 });

      expect(prompt.length).toBeLessThanOrEqual(116); // 100 + "\n... [TRUNCATED]"
      expect(prompt).toContain('... [TRUNCATED]');
    });

    it('should not truncate when under maxSize', async () => {
      await mount1.write('README.md', 'Small');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt({ maxSize: 10000 });

      expect(prompt).not.toContain('[TRUNCATED]');
      expect(prompt).toContain('Small');
    });
  });

  describe('buildPrompt - options.include', () => {
    it('should only include specified mounts', async () => {
      await mount1.write('README.md', 'Doc content');
      await mount2.write('README.md', 'Code content');
      await mount3.write('README.md', 'Asset content');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1, mount2, mount3] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('<context>');
      expect(prompt).toContain('<name>docs</name>');
      expect(prompt).toContain('<name>code</name>');
      expect(prompt).toContain('<name>assets</name>');
      expect(prompt).toContain('</context>');
      expect(prompt).toContain('Doc content');
      expect(prompt).toContain('Code content');
      expect(prompt).toContain('Asset content');
    });
  });

  describe('buildPrompt - edge cases', () => {
    it('should produce deterministic output format', async () => {
      await mount1.write('README.md', 'Test');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt1 = await pod.buildPrompt();
      const prompt2 = await pod.buildPrompt();

      expect(prompt1).toBe(prompt2);
    });

    it('should handle special characters in README', async () => {
      await mount1.write('README.md', '<tag> & "quotes"');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('<tag>');
      expect(prompt).toContain('&');
      expect(prompt).toContain('"quotes"');
    });
  });

  describe('buildPrompt - file listings', () => {
    it('should include file listings in prompt', async () => {
      await mount1.write('README.md', '# Docs');
      await mount1.write('guide.txt', 'Guide content');
      await mount1.write('tutorial.txt', 'Tutorial content');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('<files>');
      expect(prompt).toContain('guide.txt');
      expect(prompt).toContain('tutorial.txt');
      expect(prompt).toContain('</files>');
    });

    it('should show root files first, then directories', async () => {
      await mount1.write('README.md', '# Root');
      await mount1.write('root-file.txt', 'Content');
      await mount1.write('subdir/file.txt', 'Subdir content');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      const filesSection = prompt.match(/<files>([\s\S]*?)<\/files>/)?.[1] || '';
      const lines = filesSection.trim().split('\n');
      
      // Root files should appear before directories (now with sizes)
      expect(lines[0]).toMatch(/^README\.md \(.+ bytes\)$/);
      expect(lines[1]).toMatch(/^root-file\.txt \(.+ bytes\)$/);
      expect(lines[2]).toBe('subdir/');
    });

    it('should format directory structure with indentation', async () => {
      await mount1.write('docs/intro.md', 'Intro');
      await mount1.write('docs/guide.md', 'Guide');
      await mount1.write('src/index.js', 'Code');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('docs/');
      expect(prompt).toContain('  guide.md');
      expect(prompt).toContain('  intro.md');
      expect(prompt).toContain('src/');
      expect(prompt).toContain('  index.js');
    });

    it('should sort files and directories alphabetically', async () => {
      await mount1.write('zebra.txt', 'Z');
      await mount1.write('apple.txt', 'A');
      await mount1.write('beta/file.txt', 'B');
      await mount1.write('alpha/file.txt', 'A');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      const filesSection = prompt.match(/<files>([\s\S]*?)<\/files>/)?.[1] || '';
      const lines = filesSection.trim().split('\n');

      // Root files first (alphabetically) - now with sizes
      expect(lines[0]).toMatch(/^apple\.txt \(.+ bytes?\)$/);
      expect(lines[1]).toMatch(/^zebra\.txt \(.+ bytes?\)$/);
      // Then directories (alphabetically) with their contents
      expect(lines[2]).toBe('alpha/');
      expect(lines[3]).toMatch(/^ {2}file\.txt \(.+ bytes?\)$/);
      expect(lines[4]).toBe('beta/');
      expect(lines[5]).toMatch(/^ {2}file\.txt \(.+ bytes?\)$/);
    });

    it('should truncate directories with many files', async () => {
      await mount1.write('README.md', '# Root');
      
      // Create 25 files in daily-dump directory (exceeds limit of 20)
      for (let i = 1; i <= 25; i++) {
        const date = `2025-01-${String(i).padStart(2, '0')}`;
        await mount1.write(`daily-dump/${date}.txt`, 'Data');
      }

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('daily-dump/');
      expect(prompt).toContain('2025-01-01.txt');
      expect(prompt).toContain('2025-01-02.txt');
      expect(prompt).toContain('2025-01-03.txt');
      expect(prompt).toContain('... [22 more files] ...');
      expect(prompt).not.toContain('2025-01-04.txt');
    });

    it('should show all files for directories under the limit', async () => {
      // Create 15 files (under limit of 20)
      for (let i = 1; i <= 15; i++) {
        await mount1.write(`details/file${i}.txt`, 'Content');
      }

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('details/');
      expect(prompt).toContain('file1.txt');
      expect(prompt).toContain('file15.txt');
      expect(prompt).not.toContain('more files');
    });

    it('should respect maxFilesPerMount option', async () => {
      await mount1.write('file1.txt', 'A');
      await mount1.write('file2.txt', 'B');
      await mount1.write('file3.txt', 'C');
      await mount1.write('file4.txt', 'D');
      await mount1.write('file5.txt', 'E');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt({ maxFilesPerMount: 3 });

      expect(prompt).toContain('file1.txt');
      expect(prompt).toContain('file2.txt');
      expect(prompt).toContain('file3.txt');
      expect(prompt).toContain('... [truncated: 2 more files] ...');
      expect(prompt).not.toContain('file4.txt');
    });

    it('should omit files section when includeFiles is false', async () => {
      await mount1.write('README.md', '# Docs');
      await mount1.write('file.txt', 'Content');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt({ includeFiles: false });

      expect(prompt).not.toContain('<files>');
      expect(prompt).not.toContain('file.txt');
      expect(prompt).toContain('# Docs');
    });

    it('should omit files section when mount has no files', async () => {
      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('<dataSource>');
      expect(prompt).toContain('<name>docs</name>');
      expect(prompt).not.toContain('<files>');
      expect(prompt).toContain('</dataSource>');
    });

    it('should handle nested directory structures', async () => {
      await mount1.write('a/b/c/deep.txt', 'Deep file');
      await mount1.write('a/b/mid.txt', 'Mid file');
      await mount1.write('a/top.txt', 'Top file');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('a/');
      expect(prompt).toContain('  b/');
      expect(prompt).toContain('    c/');
      expect(prompt).toContain('      deep.txt');
      expect(prompt).toContain('    mid.txt');
      expect(prompt).toContain('  top.txt');
    });

    it('should include files from multiple mounts', async () => {
      await mount1.write('docs.txt', 'Docs');
      await mount2.write('code.js', 'Code');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1, mount2] });
      const prompt = await pod.buildPrompt();

      // Check mount1 files
      const docsSection = prompt.match(/<name>docs<\/name>[\s\S]*?<files>([\s\S]*?)<\/files>/)?.[1] || '';
      expect(docsSection).toContain('docs.txt');

      // Check mount2 files
      const codeSection = prompt.match(/<name>code<\/name>[\s\S]*?<files>([\s\S]*?)<\/files>/)?.[1] || '';
      expect(codeSection).toContain('code.js');
    });

    it('should apply maxFilesPerMount independently to each mount', async () => {
      await mount1.write('file1.txt', '1');
      await mount1.write('file2.txt', '2');
      await mount1.write('file3.txt', '3');
      
      await mount2.write('code1.js', 'A');
      await mount2.write('code2.js', 'B');
      await mount2.write('code3.js', 'C');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1, mount2] });
      const prompt = await pod.buildPrompt({ maxFilesPerMount: 2 });

      // Both mounts should have their own 2-file limit
      expect(prompt).toMatch(/<name>docs<\/name>[\s\S]*?file1\.txt[\s\S]*?file2\.txt/);
      expect(prompt).toMatch(/<name>code<\/name>[\s\S]*?code1\.js[\s\S]*?code2\.js/);
    });

    it('should handle files with special characters in names', async () => {
      await mount1.write('file-with-dashes.txt', 'A');
      await mount1.write('file_with_underscores.txt', 'B');
      await mount1.write('file.multiple.dots.txt', 'C');

      const pod = new ArtiPod({ useMainMount: false, mounts: [mount1] });
      const prompt = await pod.buildPrompt();

      expect(prompt).toContain('file-with-dashes.txt');
      expect(prompt).toContain('file_with_underscores.txt');
      expect(prompt).toContain('file.multiple.dots.txt');
    });
  });
});
