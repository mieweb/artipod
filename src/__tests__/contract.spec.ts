/**
 * Phase 1 contract suite: the full tools surface + buildPrompt run twice with
 * identical assertions — once over node:fs/promises (tempdir), once over
 * ZenFS InMemory. This is what pins the core as isomorphic.
 */

import * as os from 'os';
import * as path from 'path';
import { ArtiPod } from '../artipod.js';
import { ArtiMount } from '../artimount.js';
import { nodePodFs } from '../nodePodFs.js';
import type { PodFs } from '../podfs.js';
import {
  MountToolRegistry,
  PodToolRegistry,
  PodPathResolver,
  ToolName,
  allToolDefinitions,
  bashDefinition,
  BashTool,
  type BashExecutor,
  truncateOutput,
  MAX_TOOL_OUTPUT_BYTES,
  toOpenAiTools,
  toMcpTools,
  type ReadFileResult,
  type ListDirResult,
  type EditResult,
  type MultiEditResult,
} from '../tools/index.js';

interface FsContext {
  fs: PodFs;
  root: string;
  cleanup(): Promise<void>;
}

interface FsProvider {
  name: string;
  setup(): Promise<FsContext>;
}

const providers: FsProvider[] = [
  {
    name: 'node-fs-tempdir',
    async setup() {
      const fs = nodePodFs();
      const root = path.join(os.tmpdir(), `artipod-contract-${Math.random().toString(36).slice(2)}`);
      await fs.mkdir(root, { recursive: true });
      return { fs, root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
    },
  },
  {
    name: 'zenfs-inmemory',
    async setup() {
      const { configureSingle, InMemory, fs: zfs } = await import('@zenfs/core');
      await configureSingle({ backend: InMemory });
      const fs = zfs.promises as unknown as PodFs;
      const root = `/pod-${Math.random().toString(36).slice(2)}`;
      await fs.mkdir(root, { recursive: true });
      return { fs, root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
    },
  },
];

/** Deterministic fixture tree used by every contract test. */
async function seedFixture(fs: PodFs, root: string): Promise<void> {
  await fs.mkdir(`${root}/alpha/src/util`, { recursive: true });
  await fs.mkdir(`${root}/alpha/docs`, { recursive: true });
  await fs.mkdir(`${root}/beta`, { recursive: true });
  await fs.writeFile(`${root}/alpha/README.md`, '# Alpha\n\nThe alpha mount.\n');
  await fs.writeFile(`${root}/alpha/src/index.ts`, 'export const answer = 42;\nexport const noise = 1;\n');
  await fs.writeFile(`${root}/alpha/src/util/helper.ts`, 'export function help(): string {\n  return "help";\n}\n');
  await fs.writeFile(`${root}/alpha/docs/guide.md`, 'Guide line one.\nGuide line two.\nGuide line three.\n');
  await fs.writeFile(`${root}/beta/README.md`, '# Beta\n\nRead-only reference data.\n');
  await fs.writeFile(`${root}/beta/data.csv`, 'id,name\n1,one\n2,two\n');
}

describe.each(providers)('tools contract over $name', (provider) => {
  let ctx: FsContext;

  beforeAll(async () => {
    ctx = await provider.setup();
    await seedFixture(ctx.fs, ctx.root);
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  describe('ArtiMount', () => {
    it('reads, writes, lists and guards traversal identically', async () => {
      const mount = new ArtiMount('alpha', `${ctx.root}/alpha`, false, ctx.fs);
      await mount.initialize();

      expect(await mount.read('src/index.ts')).toContain('answer = 42');
      expect(await mount.read('docs/guide.md', 2, 2)).toBe('Guide line two.');

      await mount.write('scratch/new.txt', 'hello');
      expect(await mount.read('scratch/new.txt')).toBe('hello');

      const files = await mount.list();
      const names = files.map((f) => f.path).sort();
      expect(names).toContain('README.md');
      expect(names).toContain('src/util/helper.ts');

      await expect(mount.read('../beta/README.md')).rejects.toThrow(/outside mount root/);
    });

    it('rejects sibling-prefix escapes (boundary-exact traversal guard)', async () => {
      // '/root/alpha' must not admit '/root/alphaX'
      await ctx.fs.mkdir(`${ctx.root}/alphaX`, { recursive: true });
      await ctx.fs.writeFile(`${ctx.root}/alphaX/secret.txt`, 'secret');
      const mount = new ArtiMount('alpha', `${ctx.root}/alpha`, false, ctx.fs);
      await expect(mount.read(`../alphaX/secret.txt`)).rejects.toThrow(/outside mount root/);
    });

    it('enforces read-only mounts', async () => {
      const mount = new ArtiMount('beta', `${ctx.root}/beta`, true, ctx.fs);
      await expect(mount.write('x.txt', 'nope')).rejects.toThrow(/read-only/);
    });
  });

  describe('MountToolRegistry (single-mount sugar)', () => {
    let registry: MountToolRegistry;

    beforeAll(async () => {
      const mount = new ArtiMount('alpha', `${ctx.root}/alpha`, false, ctx.fs);
      await mount.initialize();
      registry = new MountToolRegistry(mount);
    });

    it('read_file v1 and v2 shapes', async () => {
      const v1 = (await registry.execute(ToolName.ReadFile, {
        filePath: 'docs/guide.md',
        startLine: 1,
        endLine: 2,
      })) as ReadFileResult;
      expect(v1.success).toBe(true);
      expect(v1.content).toBe('Guide line one.\nGuide line two.');

      const v2 = (await registry.execute(ToolName.ReadFile, {
        filePath: 'docs/guide.md',
        offset: 2,
        limit: 1,
      })) as ReadFileResult;
      expect(v2.success).toBe(true);
      expect(v2.content).toBe('Guide line two.');
    });

    it('create_file, list_dir, create_directory', async () => {
      expect((await registry.execute(ToolName.CreateFile, { filePath: 'notes/todo.md', content: '- [ ] x' })).success).toBe(true);
      expect((await registry.execute(ToolName.CreateDirectory, { dirPath: 'notes/deep/dir' })).success).toBe(true);

      const listing = (await registry.execute(ToolName.ListDirectory, { path: 'notes' })) as ListDirResult;
      expect(listing.success).toBe(true);
      expect(listing.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'todo.md', isDirectory: false }),
          expect.objectContaining({ name: 'deep', isDirectory: true }),
        ])
      );
    });

    it('replace_string_in_file and multi_replace_string_in_file', async () => {
      const single = (await registry.execute(ToolName.ReplaceString, {
        explanation: 'test',
        filePath: 'src/index.ts',
        oldString: 'answer = 42',
        newString: 'answer = 43',
      })) as EditResult;
      expect(single.success).toBe(true);
      expect(await registry.execute(ToolName.ReadFile, { filePath: 'src/index.ts', startLine: 1, endLine: 1 })).toMatchObject({
        content: 'export const answer = 43;',
      });

      const multi = (await registry.execute(ToolName.MultiReplaceString, {
        explanation: 'test',
        replacements: [
          { explanation: 'a', filePath: 'src/index.ts', oldString: 'answer = 43', newString: 'answer = 44' },
          { explanation: 'b', filePath: 'src/index.ts', oldString: 'noise = 1', newString: 'noise = 2' },
        ],
      })) as MultiEditResult;
      expect(multi.successCount).toBe(2);
      expect(multi.failureCount).toBe(0);
    });

    it('apply_patch applies a well-formed patch', async () => {
      const patch = [
        '*** Begin Patch',
        '*** Update File: docs/guide.md',
        '@@',
        ' Guide line one.',
        '-Guide line two.',
        '+Guide line 2.',
        ' Guide line three.',
        '*** End Patch',
      ].join('\n');
      const result = (await registry.execute(ToolName.ApplyPatch, { input: patch, explanation: 'test' })) as EditResult;
      expect(result.success).toBe(true);
      expect(await registry.execute(ToolName.ReadFile, { filePath: 'docs/guide.md', startLine: 2, endLine: 2 })).toMatchObject({
        content: 'Guide line 2.',
      });
      // restore for later assertions
      await registry.execute(ToolName.ReplaceString, {
        explanation: 'restore',
        filePath: 'docs/guide.md',
        oldString: 'Guide line 2.',
        newString: 'Guide line two.',
      });
    });
  });

  describe('PodToolRegistry (pod-level, declarative mount table — no prefix scheme)', () => {
    let pod: ArtiPod;
    let registry: PodToolRegistry;
    const bashCalls: string[] = [];

    beforeAll(async () => {
      const alpha = new ArtiMount('alpha', `${ctx.root}/alpha`, false, ctx.fs);
      const beta = new ArtiMount('beta', `${ctx.root}/beta`, true, ctx.fs);
      pod = new ArtiPod({ useMainMount: false, fs: ctx.fs, mounts: [alpha, beta] });
      await pod.initialize();
      const fakeBash: BashExecutor = {
        async exec(command) {
          bashCalls.push(command);
          return { stdout: `ran:${command}`, stderr: '', exitCode: 0 };
        },
      };
      registry = new PodToolRegistry(pod, {
        // Deliberately un-schemed paths: one nested, one at top level
        mountTable: [
          { path: '/context/alpha', mount: alpha },
          { path: '/refdata', mount: beta },
        ],
        bashExecutor: fakeBash,
      });
    });

    it('resolves file paths against each mount\'s declared path', async () => {
      const read = (await registry.execute(ToolName.ReadFile, {
        filePath: '/context/alpha/src/index.ts',
        startLine: 1,
        endLine: 1,
      })) as ReadFileResult;
      expect(read.success).toBe(true);
      expect(read.filePath).toBe('/context/alpha/src/index.ts');

      const csv = (await registry.execute(ToolName.ReadFile, {
        filePath: '/refdata/data.csv',
        startLine: 1,
        endLine: 3,
      })) as ReadFileResult;
      expect(csv.success).toBe(true);
      expect(csv.content).toContain('1,one');
    });

    it('lists virtual directories above the mount points', async () => {
      const rootListing = (await registry.execute(ToolName.ListDirectory, { path: '/' })) as ListDirResult;
      expect(rootListing.success).toBe(true);
      expect(rootListing.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'context', isDirectory: true }),
          expect.objectContaining({ name: 'refdata', isDirectory: true }),
        ])
      );

      const contextListing = (await registry.execute(ToolName.ListDirectory, { path: '/context' })) as ListDirResult;
      expect(contextListing.entries).toEqual([{ name: 'alpha', isDirectory: true }]);
    });

    it('writes through the owning mount and honors read-only mounts', async () => {
      expect(
        (await registry.execute(ToolName.CreateFile, { filePath: '/context/alpha/notes/pod.md', content: 'pod' })).success
      ).toBe(true);
      const denied = await registry.execute(ToolName.CreateFile, { filePath: '/refdata/hack.txt', content: 'x' });
      expect(denied.success).toBe(false);
      expect(denied.error).toMatch(/read-only/);
    });

    it('multi_replace spans mounts, replacements applied per owning mount', async () => {
      await registry.execute(ToolName.CreateFile, { filePath: '/context/alpha/multi.txt', content: 'AAA' });
      const result = (await registry.execute(ToolName.MultiReplaceString, {
        explanation: 'cross-mount',
        replacements: [
          { explanation: 'ok', filePath: '/context/alpha/multi.txt', oldString: 'AAA', newString: 'BBB' },
          { explanation: 'denied', filePath: '/refdata/data.csv', oldString: '1,one', newString: '1,uno' },
        ],
      })) as MultiEditResult;
      expect(result.successCount).toBe(1);
      expect(result.failureCount).toBe(1);
      expect(result.results[0].filePath).toBe('/context/alpha/multi.txt');
      expect(result.results[1].error).toMatch(/read-only/);
    });

    it('apply_patch resolves header paths through the mount table', async () => {
      const patch = [
        '*** Begin Patch',
        '*** Update File: /context/alpha/docs/guide.md',
        '@@',
        ' Guide line one.',
        '-Guide line two.',
        '+Guide line II.',
        ' Guide line three.',
        '*** End Patch',
      ].join('\n');
      const result = (await registry.execute(ToolName.ApplyPatch, { input: patch, explanation: 'test' })) as EditResult;
      expect(result.success).toBe(true);
      const after = (await registry.execute(ToolName.ReadFile, {
        filePath: '/context/alpha/docs/guide.md',
        startLine: 2,
        endLine: 2,
      })) as ReadFileResult;
      expect(after.content).toBe('Guide line II.');
    });

    it('unknown paths fail with the mount table in the error', async () => {
      const result = await registry.execute(ToolName.ReadFile, {
        filePath: '/nowhere/file.txt',
        startLine: 1,
        endLine: 1,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('/context/alpha');
      expect(result.error).toContain('/refdata');
    });

    it('bash executes through the injected executor with JSON body content', async () => {
      const result = await registry.execute(ToolName.Bash, { command: 'echo hi' });
      expect(result.success).toBe(true);
      expect(bashCalls).toContain('echo hi');
      expect(JSON.parse(result.content!)).toEqual({ stdout: 'ran:echo hi', stderr: '', exitCode: 0 });
    });
  });
});

describe('buildPrompt is byte-identical across node fs and ZenFS InMemory', () => {
  async function promptOver(provider: FsProvider): Promise<string> {
    const ctx = await provider.setup();
    try {
      await seedFixture(ctx.fs, ctx.root);
      const pod = new ArtiPod({
        useMainMount: false,
        fs: ctx.fs,
        mounts: [
          new ArtiMount('alpha', `${ctx.root}/alpha`, false, ctx.fs),
          new ArtiMount('beta', `${ctx.root}/beta`, true, ctx.fs),
        ],
      });
      await pod.initialize();
      return await pod.buildPrompt({ includeFiles: true, maxFilesPerMount: 50 });
    } finally {
      await ctx.cleanup();
    }
  }

  it('produces the same bytes and matches the fixture snapshot', async () => {
    const nodePrompt = await promptOver(providers[0]);
    const zenPrompt = await promptOver(providers[1]);
    expect(nodePrompt).toBe(zenPrompt);
    expect(nodePrompt).toMatchSnapshot();
  });
});

describe('bash tool truncation (ported 16 KiB semantics)', () => {
  it('leaves short output untouched', () => {
    const text = 'x'.repeat(MAX_TOOL_OUTPUT_BYTES);
    expect(truncateOutput(text)).toBe(text);
  });

  it('truncates head+tail with an omission marker', () => {
    const text = 'a'.repeat(10000) + 'b'.repeat(10000);
    const out = truncateOutput(text);
    const half = Math.floor(MAX_TOOL_OUTPUT_BYTES / 2);
    expect(out.startsWith('a'.repeat(half))).toBe(true);
    expect(out.endsWith('b'.repeat(half))).toBe(true);
    expect(out).toContain(`…[${20000 - half * 2} characters truncated]…`);
  });

  it('bash tool content JSON carries truncated streams', async () => {
    const long = 'y'.repeat(MAX_TOOL_OUTPUT_BYTES + 100);
    const executor: BashExecutor = {
      async exec() {
        return { stdout: long, stderr: '', exitCode: 0 };
      },
    };
    const tool = new BashTool(executor);
    const result = await tool.execute({ command: 'generate' });
    expect(result.success).toBe(true);
    const body = JSON.parse(result.content!);
    expect(body.stdout).toBe(truncateOutput(long));
    expect(body.exitCode).toBe(0);
    // raw streams stay untruncated for programmatic consumers
    expect(result.stdout).toHaveLength(long.length);
  });

  it('rejects empty commands and surfaces executor failures', async () => {
    const failing: BashExecutor = {
      async exec() {
        throw new Error('no backend');
      },
    };
    const tool = new BashTool(failing);
    expect((await tool.execute({ command: '   ' })).error).toBe('missing "command"');
    expect((await tool.execute({ command: 'ls' })).error).toBe('no backend');
  });

  it('bash schema matches the ported shape', () => {
    expect(bashDefinition.name).toBe('bash');
    expect(bashDefinition.inputSchema.required).toEqual(['command']);
    expect(Object.keys(bashDefinition.inputSchema.properties)).toEqual(['command']);
  });
});

describe('serializers (OpenAI + MCP dual shapes)', () => {
  it('serializes every definition into both wire shapes', () => {
    const defs = [...allToolDefinitions, bashDefinition];
    const openAi = toOpenAiTools(defs);
    const mcp = toMcpTools(defs);

    expect(openAi).toHaveLength(defs.length);
    for (const [i, def] of defs.entries()) {
      expect(openAi[i]).toEqual({
        type: 'function',
        function: { name: def.name, description: def.description, parameters: def.inputSchema },
      });
      expect(mcp[i]).toEqual({ name: def.name, description: def.description, inputSchema: def.inputSchema });
    }
  });
});

describe('PodPathResolver', () => {
  it('enforces absolute, unique mount paths and longest-prefix wins', () => {
    const m = (name: string) => new ArtiMount(name, `/tmp/${name}`);
    expect(() => new PodPathResolver([])).toThrow(/empty/);
    expect(() => new PodPathResolver([{ path: 'relative', mount: m('a') }])).toThrow(/absolute/);
    expect(
      () => new PodPathResolver([
        { path: '/a', mount: m('a') },
        { path: '/a/', mount: m('b') },
      ])
    ).toThrow(/Duplicate/);

    const resolver = new PodPathResolver([
      { path: '/data', mount: m('outer') },
      { path: '/data/inner', mount: m('inner') },
    ]);
    expect(resolver.resolve('/data/inner/x.txt').entry.mount.getName()).toBe('inner');
    expect(resolver.resolve('/data/other/x.txt').entry.mount.getName()).toBe('outer');
    expect(resolver.resolve('/data/inner/../y.txt').entry.mount.getName()).toBe('outer');
    expect(() => resolver.resolve('/elsewhere/z')).toThrow(/not under any mount/);
  });
});
