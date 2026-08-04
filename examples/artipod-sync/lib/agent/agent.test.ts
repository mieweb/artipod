/**
 * Agent loop tests with a scripted fake LLM (injected fetchFn) executing real
 * bash tool calls against a sandbox, plus truncation behavior.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { configure, InMemory, fs as zfs, umount } from '@zenfs/core';
import { createSandbox, type Sandbox } from '../sandbox';
import { ToolCallingLoop } from './loop';
import { OzwellClient } from './ozwell-client';
import { createSandboxTools, toMcpToolDescriptors, truncateOutput, MAX_TOOL_OUTPUT_BYTES } from './tools';
import type { ChatCompletionResponse, ChatMessage, ToolCall } from './types';

let sandbox: Sandbox;

beforeEach(async () => {
  try {
    umount('/');
  } catch {
    // first run
  }
  await configure({ mounts: { '/': InMemory } });
  await zfs.promises.mkdir('/repo');
  sandbox = createSandbox({ zfs });
});

function scriptedClient(script: Array<Partial<ChatMessage>>): { client: OzwellClient; requests: unknown[] } {
  const requests: unknown[] = [];
  let call = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const message = script[Math.min(call++, script.length - 1)];
    const response: ChatCompletionResponse = {
      id: `fake-${call}`,
      object: 'chat.completion',
      created: Date.now() / 1000,
      model: 'fake',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, ...message } as ChatMessage,
          finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    return new Response(JSON.stringify(response), { status: 200 });
  };
  const client = new OzwellClient({ baseUrl: 'http://fake', apiKey: 'k', fetchFn });
  return { client, requests };
}

const bashCall = (id: string, command: string): ToolCall => ({
  id,
  type: 'function',
  function: { name: 'bash', arguments: JSON.stringify({ command }) },
});

describe('ToolCallingLoop with sandbox tools', () => {
  it('executes tool calls and feeds results back until final response', async () => {
    const { client, requests } = scriptedClient([
      { tool_calls: [bashCall('c1', 'echo hello > greet.txt'), bashCall('c2', 'cat greet.txt')] },
      { content: 'The file says hello.' },
    ]);
    const loop = new ToolCallingLoop(client, createSandboxTools(sandbox));

    const calls: string[] = [];
    const result = await loop.run('write then read a file', {
      onToolCall: (c) => calls.push(JSON.parse(c.function.arguments).command),
    });

    expect(result.content).toBe('The file says hello.');
    expect(result.iterations).toBe(2);
    expect(calls).toEqual(['echo hello > greet.txt', 'cat greet.txt']);
    expect(result.usage.total_tokens).toBe(30);

    // Tool results made it back into the conversation with matching ids.
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['c1', 'c2']);
    expect(JSON.parse(toolMsgs[1].content ?? '')).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(toolMsgs[1].content ?? '').stdout).toBe('hello\n');

    // The second LLM request contained the first tool result.
    expect(JSON.stringify(requests[1])).toContain('"tool_call_id":"c1"');

    // File really exists in the sandbox.
    expect(await zfs.promises.readFile('/repo/greet.txt', 'utf8')).toBe('hello\n');
  });

  it('reports unknown tools without crashing the loop', async () => {
    const { client } = scriptedClient([
      {
        tool_calls: [
          { id: 'x', type: 'function', function: { name: 'nope', arguments: '{}' } },
        ],
      },
      { content: 'ok' },
    ]);
    const loop = new ToolCallingLoop(client, createSandboxTools(sandbox));
    const result = await loop.run('use a bad tool');
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toMatch(/Unknown tool: nope/);
    expect(result.content).toBe('ok');
  });

  it('stops at maxIterations', async () => {
    const { client } = scriptedClient([{ tool_calls: [bashCall('l', 'true')] }]); // never final
    const loop = new ToolCallingLoop(client, createSandboxTools(sandbox));
    await expect(loop.run('loop forever', { maxIterations: 3 })).rejects.toThrow(/Maximum iterations \(3\)/);
  });

  it('aborts between steps via AbortSignal', async () => {
    const controller = new AbortController();
    const { client } = scriptedClient([{ tool_calls: [bashCall('a', 'true')] }]);
    const loop = new ToolCallingLoop(client, createSandboxTools(sandbox));
    controller.abort();
    await expect(loop.run('x', { signal: controller.signal })).rejects.toThrow(/abort/i);
  });

  it('truncates giant tool output to protect the context window', async () => {
    const { client } = scriptedClient([
      { tool_calls: [bashCall('big', 'seq 1 20000')] },
      { content: 'done' },
    ]);
    const loop = new ToolCallingLoop(client, createSandboxTools(sandbox));
    const result = await loop.run('flood');
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg?.content ?? '{}');
    expect(parsed.stdout.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES + 100);
    expect(parsed.stdout).toMatch(/characters truncated/);
    // head and tail survive
    expect(parsed.stdout.startsWith('1\n2\n')).toBe(true);
    expect(parsed.stdout.trimEnd().endsWith('20000')).toBe(true);
  });
});

describe('tool surface serializers', () => {
  it('exposes the same tools as OpenAI definitions and MCP descriptors', () => {
    const tools = createSandboxTools(sandbox);
    const mcp = toMcpToolDescriptors(tools);
    expect(mcp.map((t) => t.name).sort()).toEqual(['bash', 'list_files', 'read_file', 'write_file']);
    const bash = mcp.find((t) => t.name === 'bash');
    expect(bash?.inputSchema.required).toEqual(['command']);
    expect(bash?.inputSchema.type).toBe('object');
  });

  it('read_file/write_file/list_files operate relative to the shell cwd', async () => {
    const tools = createSandboxTools(sandbox);
    await tools.get('write_file')!.execute({ path: 'note.md', content: 'hi' });
    const read = await tools.get('read_file')!.execute({ path: 'note.md' });
    expect(read).toMatchObject({ success: true, content: 'hi' });
    const listing = await tools.get('list_files')!.execute({});
    expect(listing.content).toMatch(/note\.md/);
  });
});

describe('truncateOutput', () => {
  it('keeps short output untouched and marks long output', () => {
    expect(truncateOutput('short')).toBe('short');
    const long = 'x'.repeat(MAX_TOOL_OUTPUT_BYTES + 1000);
    const out = truncateOutput(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toMatch(/\[1000 characters truncated\]/);
  });
});
