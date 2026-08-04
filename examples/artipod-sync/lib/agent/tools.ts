/**
 * Sandbox-bound tools for the agent loop: `bash` plus read/write/list
 * conveniences (cheaper in tokens than cat/echo round-trips).
 *
 * One source of truth for the tool surface, two serializers:
 * OpenAI function-call shape (ToolDefinition, used by the loop) and an
 * MCP-style descriptor (toMcpToolDescriptors, for MCPToolCall-style UIs).
 */
import type { Sandbox } from '../sandbox/types';
import type { McpToolDescriptor, ToolDefinition, ToolHandler, ToolResult } from './types';

/** Cap tool output to protect the model's context window (head + tail). */
export const MAX_TOOL_OUTPUT_BYTES = 16 * 1024;

export function truncateOutput(text: string, maxBytes = MAX_TOOL_OUTPUT_BYTES): string {
  if (text.length <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n…[${omitted} characters truncated]…\n${text.slice(-half)}`;
}

const okResult = (content: string): ToolResult => ({ success: true, content });
const errResult = (error: string): ToolResult => ({ success: false, content: '', error });

export function createSandboxTools(sandbox: Sandbox): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();

  tools.set('bash', {
    definition: {
      type: 'function',
      function: {
        name: 'bash',
        description:
          'Execute a bash command in the persistent sandbox (pipes, globs, redirects, ~90 coreutils, plus git and edit). cwd, variables and aliases persist between calls. Output is truncated to 16 KiB.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command line to execute' },
          },
          required: ['command'],
        },
      },
    },
    execute: async (args, signal) => {
      const command = String(args.command ?? '');
      if (!command) return errResult('missing "command"');
      const r = await sandbox.exec(command, { signal });
      const body = JSON.stringify({
        stdout: truncateOutput(r.stdout),
        stderr: truncateOutput(r.stderr),
        exitCode: r.exitCode,
      });
      return okResult(body);
    },
  });

  tools.set('read_file', {
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a text file from the sandbox filesystem (cheaper than bash cat).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute, or relative to the shell cwd)' },
          },
          required: ['path'],
        },
      },
    },
    execute: async (args) => {
      const path = resolveArgPath(sandbox, args.path);
      if (!path) return errResult('missing "path"');
      try {
        return okResult(truncateOutput(await sandbox.fs.readFile(path)));
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });

  tools.set('write_file', {
    definition: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write (create or overwrite) a text file in the sandbox filesystem.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute, or relative to the shell cwd)' },
            content: { type: 'string', description: 'Full file content' },
          },
          required: ['path', 'content'],
        },
      },
    },
    execute: async (args) => {
      const path = resolveArgPath(sandbox, args.path);
      if (!path) return errResult('missing "path"');
      try {
        await sandbox.fs.writeFile(path, String(args.content ?? ''));
        return okResult(`wrote ${path}`);
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });

  tools.set('list_files', {
    definition: {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List directory entries (directories get a trailing slash).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path; defaults to the shell cwd' },
          },
        },
      },
    },
    execute: async (args) => {
      const path = resolveArgPath(sandbox, args.path ?? '.') ?? sandbox.getCwd();
      try {
        const entries = await sandbox.fs.readdirWithFileTypes(path);
        const listing = entries
          .map((e) => (e.isDirectory ? `${e.name}/` : e.name))
          .sort()
          .join('\n');
        return okResult(truncateOutput(listing));
      } catch (e) {
        return errResult((e as Error).message);
      }
    },
  });

  return tools;
}

function resolveArgPath(sandbox: Sandbox, value: unknown): string | null {
  const raw = String(value ?? '');
  if (!raw) return null;
  return sandbox.fs.resolvePath(sandbox.getCwd(), raw);
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
