import { ArtiMount } from '../artimount.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  ReadFileTool,
  CreateFileTool,
  ListDirTool,
  CreateDirectoryTool,
  ReplaceStringTool,
  MultiReplaceStringTool,
  ApplyPatchTool,
  MountToolRegistry,
  PodToolRegistry,
  RunTerminalTool,
  ToolName,
} from '../tools/index.js';
import { ArtiPod } from '../artipod.js';

describe('Tools', () => {
  let testDir: string;
  let mount: ArtiMount;

  beforeEach(async () => {
    // Create unique test directory
    testDir = path.join(process.cwd(), 'test-mounts', `test-tools-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    mount = new ArtiMount('test-mount', testDir);
    await mount.initialize();
  });

  afterEach(async () => {
    // Clean up test directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('ReadFileTool', () => {
    let tool: ReadFileTool;

    beforeEach(() => {
      tool = new ReadFileTool(mount);
    });

    it('should have correct name and definition', () => {
      expect(tool.name).toBe(ToolName.ReadFile);
      expect(tool.definition).toBeDefined();
      expect(tool.definition.name).toBe('read_file');
    });

    it('should read entire file with v1 params', async () => {
      await mount.write('test.txt', 'line 1\nline 2\nline 3');

      const result = await tool.execute({
        filePath: 'test.txt',
        startLine: 1,
        endLine: 3,
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe('line 1\nline 2\nline 3');
      expect(result.totalLines).toBe(3);
      expect(result.startLine).toBe(1);
      expect(result.endLine).toBe(3);
    });

    it('should read partial file with v1 params', async () => {
      await mount.write('test.txt', 'line 1\nline 2\nline 3\nline 4\nline 5');

      const result = await tool.execute({
        filePath: 'test.txt',
        startLine: 2,
        endLine: 4,
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe('line 2\nline 3\nline 4');
      expect(result.totalLines).toBe(5);
    });

    it('should read file with v2 params (offset/limit)', async () => {
      await mount.write('test.txt', 'line 1\nline 2\nline 3\nline 4\nline 5');

      const result = await tool.execute({
        filePath: 'test.txt',
        offset: 2,
        limit: 2,
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe('line 2\nline 3');
    });

    it('should read from beginning with v2 params when no offset', async () => {
      await mount.write('test.txt', 'line 1\nline 2\nline 3');

      const result = await tool.execute({
        filePath: 'test.txt',
        limit: 2,
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe('line 1\nline 2');
    });

    it('should return error for non-existent file', async () => {
      const result = await tool.execute({
        filePath: 'nonexistent.txt',
        startLine: 1,
        endLine: 10,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should clamp out-of-range lines', async () => {
      await mount.write('test.txt', 'line 1\nline 2\nline 3');

      const result = await tool.execute({
        filePath: 'test.txt',
        startLine: 1,
        endLine: 100,
      });

      expect(result.success).toBe(true);
      expect(result.endLine).toBe(3);
    });

    it('should error when offset exceeds file length', async () => {
      await mount.write('test.txt', 'line 1\nline 2');

      const result = await tool.execute({
        filePath: 'test.txt',
        offset: 100,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid offset');
    });
  });

  describe('CreateFileTool', () => {
    let tool: CreateFileTool;

    beforeEach(() => {
      tool = new CreateFileTool(mount);
    });

    it('should have correct name and definition', () => {
      expect(tool.name).toBe(ToolName.CreateFile);
      expect(tool.definition.name).toBe('create_file');
    });

    it('should create a new file', async () => {
      const result = await tool.execute({
        filePath: 'newfile.txt',
        content: 'Hello, world!',
      });

      expect(result.success).toBe(true);
      const content = await mount.read('newfile.txt');
      expect(content).toBe('Hello, world!');
    });

    it('should create file in subdirectory', async () => {
      const result = await tool.execute({
        filePath: 'subdir/deep/file.txt',
        content: 'Nested content',
      });

      expect(result.success).toBe(true);
      const content = await mount.read('subdir/deep/file.txt');
      expect(content).toBe('Nested content');
    });

    it('should create empty file when no content provided', async () => {
      const result = await tool.execute({
        filePath: 'empty.txt',
      });

      expect(result.success).toBe(true);
      const content = await mount.read('empty.txt');
      expect(content).toBe('');
    });

    it('should fail if file already exists', async () => {
      await mount.write('existing.txt', 'original content');

      const result = await tool.execute({
        filePath: 'existing.txt',
        content: 'new content',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });

  describe('ListDirTool', () => {
    let tool: ListDirTool;

    beforeEach(() => {
      tool = new ListDirTool(mount);
    });

    it('should have correct name and definition', () => {
      expect(tool.name).toBe(ToolName.ListDirectory);
      expect(tool.definition.name).toBe('list_dir');
    });

    it('should list files in root directory', async () => {
      await mount.write('file1.txt', 'content1');
      await mount.write('file2.txt', 'content2');

      const result = await tool.execute({ path: '' });

      expect(result.success).toBe(true);
      expect(result.entries).toBeDefined();
      const names = result.entries!.map(e => e.name);
      expect(names).toContain('file1.txt');
      expect(names).toContain('file2.txt');
    });

    it('should list subdirectories', async () => {
      await mount.write('subdir/file.txt', 'content');

      const result = await tool.execute({ path: '' });

      expect(result.success).toBe(true);
      const subdirEntry = result.entries!.find(e => e.name === 'subdir');
      expect(subdirEntry).toBeDefined();
      expect(subdirEntry!.isDirectory).toBe(true);
    });

    it('should list contents of subdirectory', async () => {
      await mount.write('subdir/file1.txt', 'content1');
      await mount.write('subdir/file2.txt', 'content2');

      const result = await tool.execute({ path: 'subdir' });

      expect(result.success).toBe(true);
      const names = result.entries!.map(e => e.name);
      expect(names).toContain('file1.txt');
      expect(names).toContain('file2.txt');
    });

    it('should sort directories before files', async () => {
      await mount.write('a_file.txt', 'content');
      await mount.write('z_dir/nested.txt', 'content');

      const result = await tool.execute({ path: '' });

      expect(result.success).toBe(true);
      const entries = result.entries!;
      const dirIndex = entries.findIndex(e => e.name === 'z_dir');
      const fileIndex = entries.findIndex(e => e.name === 'a_file.txt');
      expect(dirIndex).toBeLessThan(fileIndex);
    });
  });

  describe('CreateDirectoryTool', () => {
    let tool: CreateDirectoryTool;

    beforeEach(() => {
      tool = new CreateDirectoryTool(mount);
    });

    it('should have correct name and definition', () => {
      expect(tool.name).toBe(ToolName.CreateDirectory);
      expect(tool.definition.name).toBe('create_directory');
    });

    it('should create a directory', async () => {
      const result = await tool.execute({ dirPath: 'newdir' });

      expect(result.success).toBe(true);
      
      // Verify by listing
      const listTool = new ListDirTool(mount);
      const listResult = await listTool.execute({ path: '' });
      const names = listResult.entries!.map(e => e.name);
      expect(names).toContain('newdir');
    });

    it('should create nested directories', async () => {
      const result = await tool.execute({ dirPath: 'a/b/c' });

      expect(result.success).toBe(true);
    });
  });

  describe('ReplaceStringTool', () => {
    let tool: ReplaceStringTool;

    beforeEach(() => {
      tool = new ReplaceStringTool(mount);
    });

    it('should have correct name and definition', () => {
      expect(tool.name).toBe(ToolName.ReplaceString);
      expect(tool.definition.name).toBe('replace_string_in_file');
    });

    it('should replace a string in file', async () => {
      await mount.write('test.txt', 'Hello, world!');

      const result = await tool.execute({
        filePath: 'test.txt',
        oldString: 'world',
        newString: 'universe',
        explanation: 'Replace world with universe',
      });

      expect(result.success).toBe(true);
      const content = await mount.read('test.txt');
      expect(content).toBe('Hello, universe!');
    });

    it('should replace multiline content', async () => {
      await mount.write('test.txt', 'line 1\nline 2\nline 3');

      const result = await tool.execute({
        filePath: 'test.txt',
        oldString: 'line 1\nline 2',
        newString: 'new line 1\nnew line 2',
        explanation: 'Replace multiline content',
      });

      expect(result.success).toBe(true);
      const content = await mount.read('test.txt');
      expect(content).toBe('new line 1\nnew line 2\nline 3');
    });

    it('should fail when string not found', async () => {
      await mount.write('test.txt', 'Hello, world!');

      const result = await tool.execute({
        filePath: 'test.txt',
        oldString: 'nonexistent',
        newString: 'replacement',
        explanation: 'Try to replace nonexistent string',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail when multiple matches found', async () => {
      await mount.write('test.txt', 'hello hello hello');

      const result = await tool.execute({
        filePath: 'test.txt',
        oldString: 'hello',
        newString: 'hi',
        explanation: 'Try to replace ambiguous match',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('found 3 times');
    });

    it('should fail when old equals new', async () => {
      await mount.write('test.txt', 'Hello, world!');

      const result = await tool.execute({
        filePath: 'test.txt',
        oldString: 'world',
        newString: 'world',
        explanation: 'Try to replace with same string',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('identical');
    });

    it('should fail for non-existent file', async () => {
      const result = await tool.execute({
        filePath: 'nonexistent.txt',
        oldString: 'hello',
        newString: 'world',
        explanation: 'Try to edit non-existent file',
      });

      expect(result.success).toBe(false);
    });
  });

  describe('MultiReplaceStringTool', () => {
    let tool: MultiReplaceStringTool;

    beforeEach(() => {
      tool = new MultiReplaceStringTool(mount);
    });

    it('should have correct name and definition', () => {
      expect(tool.name).toBe(ToolName.MultiReplaceString);
      expect(tool.definition.name).toBe('multi_replace_string_in_file');
    });

    it('should perform multiple replacements', async () => {
      await mount.write('file1.txt', 'Hello, world!');
      await mount.write('file2.txt', 'Goodbye, world!');

      const result = await tool.execute({
        explanation: 'Update greetings',
        replacements: [
          {
            filePath: 'file1.txt',
            oldString: 'world',
            newString: 'universe',
            explanation: 'Update file1',
          },
          {
            filePath: 'file2.txt',
            oldString: 'world',
            newString: 'universe',
            explanation: 'Update file2',
          },
        ],
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(2);
      expect(result.results!.every(r => r.success)).toBe(true);

      const content1 = await mount.read('file1.txt');
      const content2 = await mount.read('file2.txt');
      expect(content1).toBe('Hello, universe!');
      expect(content2).toBe('Goodbye, universe!');
    });

    it('should report partial failures', async () => {
      await mount.write('file1.txt', 'Hello, world!');

      const result = await tool.execute({
        explanation: 'Mixed results',
        replacements: [
          {
            filePath: 'file1.txt',
            oldString: 'world',
            newString: 'universe',
            explanation: 'This should work',
          },
          {
            filePath: 'nonexistent.txt',
            oldString: 'hello',
            newString: 'hi',
            explanation: 'This should fail',
          },
        ],
      });

      expect(result.success).toBe(false); // Overall failure due to partial failure
      expect(result.results).toHaveLength(2);
      expect(result.results![0].success).toBe(true);
      expect(result.results![1].success).toBe(false);
    });

    it('should handle empty replacements array', async () => {
      const result = await tool.execute({
        explanation: 'Empty',
        replacements: [],
      });

      expect(result.success).toBe(true);
      expect(result.results).toHaveLength(0);
    });
  });

  describe('ApplyPatchTool', () => {
    let tool: ApplyPatchTool;

    beforeEach(() => {
      tool = new ApplyPatchTool(mount);
    });

    it('should have correct name and definition', () => {
      expect(tool.name).toBe(ToolName.ApplyPatch);
      expect(tool.definition.name).toBe('apply_patch');
    });

    it('should apply a simple patch to add content', async () => {
      await mount.write('test.txt', 'line 1\nline 2\nline 3\n');

      // Use the OpenAI-style patch format expected by the parser
      const patch = `*** Begin Patch
*** Update File: test.txt
@@ line 2 @@
 line 2
+new line
 line 3
*** End Patch`;

      const result = await tool.execute({ input: patch, explanation: 'Apply patch to add line' });

      expect(result.success).toBe(true);
      const content = await mount.read('test.txt');
      expect(content).toContain('new line');
    });

    it('should fail with invalid patch format', async () => {
      const result = await tool.execute({ input: 'not a valid patch', explanation: 'Try invalid patch' });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should fail when input is empty', async () => {
      const result = await tool.execute({ input: '', explanation: 'Try empty patch' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should fail when input is not a string', async () => {
      const result = await tool.execute({ input: null as unknown as string, explanation: 'Try null input' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });
  });

  describe('MountToolRegistry', () => {
    let registry: MountToolRegistry;

    beforeEach(() => {
      registry = new MountToolRegistry(mount);
    });

    it('should register all tools', () => {
      expect(registry.has(ToolName.ReadFile)).toBe(true);
      expect(registry.has(ToolName.CreateFile)).toBe(true);
      expect(registry.has(ToolName.ListDirectory)).toBe(true);
      expect(registry.has(ToolName.CreateDirectory)).toBe(true);
      expect(registry.has(ToolName.ReplaceString)).toBe(true);
      expect(registry.has(ToolName.MultiReplaceString)).toBe(true);
      expect(registry.has(ToolName.ApplyPatch)).toBe(true);
    });

    it('should get tool by name', () => {
      const tool = registry.get(ToolName.ReadFile);
      expect(tool).toBeDefined();
      expect(tool!.name).toBe(ToolName.ReadFile);
    });

    it('should return undefined for unknown tool', () => {
      const tool = registry.get('unknown_tool');
      expect(tool).toBeUndefined();
    });

    it('should get all tools', () => {
      const tools = registry.getAll();
      expect(tools.length).toBe(7);
    });

    it('should get all definitions', () => {
      const definitions = registry.getDefinitions();
      expect(definitions.length).toBe(7);
      expect(definitions.every(d => d.name && d.description)).toBe(true);
    });

    it('should execute tool by name', async () => {
      await mount.write('test.txt', 'Hello');

      const result = await registry.execute(ToolName.ReadFile, {
        filePath: 'test.txt',
        startLine: 1,
        endLine: 1,
      });

      expect(result.success).toBe(true);
      expect((result as { content: string }).content).toBe('Hello');
    });

    it('should return error for unknown tool execution', async () => {
      const result = await registry.execute('unknown_tool', {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('PodToolRegistry', () => {
    let pod: ArtiPod;
    let registry: PodToolRegistry;

    beforeEach(async () => {
      pod = new ArtiPod({
        workspaceDir: testDir,
        useMainMount: true,
      });
      await pod.initialize();
      registry = new PodToolRegistry(pod);
    });

    afterEach(async () => {
      if (pod.hasContainer()) {
        await pod.stopContainer();
      }
      await pod.cleanupMainMount();
    });

    it('should register RunTerminal tool', () => {
      expect(registry.has(ToolName.RunTerminal)).toBe(true);
    });

    it('should get tool by name', () => {
      const tool = registry.get(ToolName.RunTerminal);
      expect(tool).toBeDefined();
      expect(tool!.name).toBe(ToolName.RunTerminal);
    });

    it('should get all tools', () => {
      const tools = registry.getAll();
      expect(tools.length).toBe(1);
    });

    it('should get all definitions', () => {
      const definitions = registry.getDefinitions();
      expect(definitions.length).toBe(1);
      expect(definitions[0].name).toBe('run_in_terminal');
    });
  });

  describe('RunTerminalTool', () => {
    let pod: ArtiPod;
    let tool: RunTerminalTool;
    let dockerfilePath: string;
    let seccompProfilePath: string;

    beforeEach(async () => {
      // Setup container config paths
      dockerfilePath = path.join(process.cwd(), 'container', 'Dockerfile');
      seccompProfilePath = path.join(process.cwd(), 'container', 'seccomp-profiles', 'sandbox.json');
      
      pod = new ArtiPod({
        workspaceDir: testDir,
        useMainMount: true,
      });
      await pod.initialize();
      tool = new RunTerminalTool(pod);
    }, 120000);

    afterEach(async () => {
      if (pod.hasContainer()) {
        await pod.stopContainer();
      }
      await pod.cleanupMainMount();
    }, 120000);

    it('should have correct name and definition', () => {
      expect(tool.name).toBe(ToolName.RunTerminal);
      expect(tool.definition).toBeDefined();
      expect(tool.definition.name).toBe('run_in_terminal');
    });

    it('should return error when command is empty', async () => {
      const result = await tool.execute({ command: '' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Command is required');
    });

    it('should return error when container is not running', async () => {
      const result = await tool.execute({ command: 'echo test' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No container running');
    });

    it('should execute simple command successfully', async () => {
      await pod.startContainer(dockerfilePath, { seccompProfilePath });

      const result = await tool.execute({ command: 'echo "Hello World"' });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('Hello World');
      expect(result.stderr).toBe('');
    }, 120000);

    it('should handle command with non-zero exit code', async () => {
      await pod.startContainer(dockerfilePath, { seccompProfilePath });

      const result = await tool.execute({ command: 'exit 42' });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(42);
    }, 120000);

    it('should execute command with stderr', async () => {
      await pod.startContainer(dockerfilePath, { seccompProfilePath });

      const result = await tool.execute({ command: 'echo "error message" >&2' });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.trim()).toBe('error message');
    }, 120000);

    it('should execute command in /context directory', async () => {
      await pod.startContainer(dockerfilePath, { seccompProfilePath });

      const result = await tool.execute({ command: 'pwd' });

      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('/context');
    }, 120000);

    it('should change directory with cd command', async () => {
      await pod.startContainer(dockerfilePath, { seccompProfilePath });

      const result = await tool.execute({ command: 'cd /tmp && pwd' });

      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('/tmp');
    }, 120000);

    it('should handle timeout parameter', async () => {
      await pod.startContainer(dockerfilePath, { seccompProfilePath });

      // Test with valid timeout
      const result = await tool.execute({ 
        command: 'echo test', 
        timeout: 5000 
      });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    }, 120000);

    it('should clamp timeout to valid range', async () => {
      await pod.startContainer(dockerfilePath, { seccompProfilePath });

      // Test with timeout below minimum (should be clamped to 1000ms)
      const result1 = await tool.execute({ 
        command: 'echo test', 
        timeout: 100 
      });
      expect(result1.success).toBe(true);

      // Test with timeout above maximum (should be clamped to 300000ms)
      const result2 = await tool.execute({ 
        command: 'echo test', 
        timeout: 500000 
      });
      expect(result2.success).toBe(true);
    }, 120000);

    it('should reject invalid timeout', async () => {
      await pod.startContainer(dockerfilePath, { seccompProfilePath });

      const result = await tool.execute({ 
        command: 'echo test', 
        timeout: -1 
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout must be a positive number');
    }, 120000);

    it('should handle complex bash commands', async () => {
      await pod.startContainer(dockerfilePath, { seccompProfilePath });

      const result = await tool.execute({ 
        command: 'for i in 1 2 3; do echo $i; done' 
      });

      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('1\n2\n3');
    }, 120000);

    it('should access files in main mount', async () => {
      await pod.startContainer(dockerfilePath, { seccompProfilePath });

      // Create a test file in the main mount
      const mainMount = pod.getMount('main')!;
      await mainMount.write('test-file.txt', 'test content');

      const result = await tool.execute({ 
        command: 'cat /context/main/test-file.txt' 
      });

      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('test content');
    }, 120000);

    it('should leave modifiedFiles undefined', async () => {
      await pod.startContainer(dockerfilePath, { seccompProfilePath });

      const result = await tool.execute({ command: 'echo test' });

      expect(result.modifiedFiles).toBeUndefined();
    }, 120000);
  });
});

