/**
 * Agent tool bindings — resolves plan §2 collision #1: the agent's file tools
 * ARE the package's VS Code-schema tools (read_file, create_file, list_dir,
 * create_directory, replace_string_in_file, multi_replace_string_in_file,
 * apply_patch) resolved over a mount table. artipod-sync's minimal
 * read_file/write_file/list_files shapes are gone.
 *
 * `bash` keeps artipod-sync's semantics: JSON body with per-stream 16 KiB
 * head+tail truncation, executed in the persistent sandbox session.
 */
import { ArtiMount } from '../artimount.js';
import type { PodFs } from '../podfs.js';
import type { Sandbox } from '../sandbox/types.js';
import { bashDefinition } from '../tools/bashTool.js';
import { PodPathResolver, createPodFileTools, type MountTableEntry } from '../tools/podFileTools.js';
import { toOpenAiTool } from '../tools/serializers.js';
import { truncateOutput } from '../tools/truncation.js';
import type { ToolHandler as CoreToolHandler, ToolResult as CoreToolResult } from '../tools/types.js';
import type { McpToolDescriptor, ToolDefinition, ToolHandler, ToolResult } from './types.js';

export { MAX_TOOL_OUTPUT_BYTES, truncateOutput } from '../tools/truncation.js';

const okResult = (content: string): ToolResult => ({ success: true, content });
const errResult = (error: string): ToolResult => ({ success: false, content: '', error });

/** An app-declared mount the file tools resolve against (plan Decision #3). */
export interface SandboxMountDeclaration {
  name: string;
  path: string;
  readonly?: boolean;
}

export interface CreateSandboxToolsOptions {
  /** Mount table for the file tools. Default: one writable mount at '/'. */
  mounts?: SandboxMountDeclaration[];
}

/** Adapt a core (structured-result) handler to the agent's OpenAI wire shape. */
function adaptCoreHandler(handler: CoreToolHandler): ToolHandler {
  return {
    definition: toOpenAiTool(handler.definition) as ToolDefinition,
    execute: async (args) => {
      const result = (await handler.execute(args as never)) as CoreToolResult;
      if (!result.success) return errResult(result.error ?? `${handler.name} failed`);
      if (typeof result.content === 'string') return okResult(truncateOutput(result.content));
      const { success: _success, ...rest } = result;
      return okResult(truncateOutput(JSON.stringify(rest)));
    },
  };
}

export function createSandboxTools(
  sandbox: Sandbox,
  options: CreateSandboxToolsOptions = {},
): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();

  tools.set('bash', {
    definition: toOpenAiTool(bashDefinition) as ToolDefinition,
    execute: async (args, signal) => {
      const command = String(args.command ?? '');
      if (!command) return errResult('missing "command"');
      const r = await sandbox.exec(command, { signal });
      return okResult(
        JSON.stringify({
          stdout: truncateOutput(r.stdout),
          stderr: truncateOutput(r.stderr),
          exitCode: r.exitCode,
        }),
      );
    },
  });

  // VS Code-schema file tools over the sandbox's own store. ZenFS's
  // `fs.promises` is PodFs-shaped, so the mounts share the shell's view.
  const podFs = sandbox.zfs.promises as unknown as PodFs;
  const declarations = options.mounts ?? [{ name: 'root', path: '/' }];
  const entries: MountTableEntry[] = declarations.map((m) => ({
    path: m.path,
    mount: new ArtiMount(m.name, m.path, m.readonly ?? false, podFs),
  }));
  const resolver = new PodPathResolver(entries);
  for (const handler of createPodFileTools(resolver)) {
    tools.set(handler.name, adaptCoreHandler(handler));
  }

  return tools;
}

/** OpenAI function-call JSON shape (what the loop / ozwellChat speak). */
export function toOpenAiToolDefinitions(tools: Map<string, ToolHandler>): ToolDefinition[] {
  return Array.from(tools.values()).map((t) => t.definition);
}

/** MCP-style descriptors (what MCPToolCall-style components render). */
export function toMcpToolDescriptors(tools: Map<string, ToolHandler>): McpToolDescriptor[] {
  return Array.from(tools.values()).map(({ definition: { function: fn } }) => ({
    name: fn.name,
    description: fn.description,
    inputSchema: fn.parameters,
  }));
}
