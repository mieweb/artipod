/**
 * Local-model plumbing: tool-call parsing for Qwen/Llama output shapes and
 * the registry's curated fallback behavior.
 */
import { describe, expect, it } from 'vitest';
import { parseGeneration } from './parse-tool-calls';
import { CURATED_MODELS, listLocalModels, modelInfo } from './model-registry';

describe('parseGeneration', () => {
  it('extracts Qwen-style <tool_call> blocks', () => {
    const out = parseGeneration(
      'Let me check.\n<tool_call>\n{"name": "bash", "arguments": {"command": "ls /repo"}}\n</tool_call>',
    );
    expect(out.content).toBe('Let me check.');
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].function.name).toBe('bash');
    expect(JSON.parse(out.toolCalls[0].function.arguments)).toEqual({ command: 'ls /repo' });
  });

  it('extracts multiple blocks in order', () => {
    const out = parseGeneration(
      '<tool_call>{"name": "a", "arguments": {}}</tool_call><tool_call>{"name": "b", "arguments": {"x": 1}}</tool_call>',
    );
    expect(out.toolCalls.map((c) => c.function.name)).toEqual(['a', 'b']);
    expect(out.content).toBe('');
  });

  it('parses Llama-style bare JSON with parameters', () => {
    const out = parseGeneration('{"name": "read_file", "parameters": {"path": "README.md"}}');
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0].function.name).toBe('read_file');
    expect(JSON.parse(out.toolCalls[0].function.arguments)).toEqual({ path: 'README.md' });
    expect(out.content).toBe('');
  });

  it('leaves plain text and JSON-looking prose untouched', () => {
    expect(parseGeneration('The answer is 42.')).toEqual({ content: 'The answer is 42.', toolCalls: [] });
    const prose = parseGeneration('{"not": "a tool call"}');
    expect(prose.toolCalls).toHaveLength(0);
    expect(prose.content).toBe('{"not": "a tool call"}');
  });

  it('keeps malformed tool_call blocks visible as content', () => {
    const out = parseGeneration('<tool_call>{oops</tool_call>');
    expect(out.toolCalls).toHaveLength(0);
    expect(out.content).toContain('<tool_call>');
  });

  it('assigns unique ids', () => {
    const out = parseGeneration(
      '<tool_call>{"name": "a", "arguments": {}}</tool_call><tool_call>{"name": "a", "arguments": {}}</tool_call>',
    );
    expect(out.toolCalls[0].id).not.toBe(out.toolCalls[1].id);
  });
});

describe('model registry', () => {
  it('falls back to the curated list when the Hub is unreachable', async () => {
    const failingFetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    expect(await listLocalModels(failingFetch)).toEqual(CURATED_MODELS);
  });

  it('merges instruct-style Hub models after the curated ones', async () => {
    const hubFetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            { id: 'onnx-community/Qwen2.5-1.5B-Instruct' }, // duplicate — skipped
            { id: 'onnx-community/SomeChat-2B-Instruct' },
            { id: 'onnx-community/turn-detector-GQA-ONNX' }, // not instruct — skipped
          ]),
        ),
      )) as unknown as typeof fetch;
    const models = await listLocalModels(hubFetch);
    expect(models.slice(0, CURATED_MODELS.length)).toEqual(CURATED_MODELS);
    expect(models.map((m) => m.id)).toContain('onnx-community/SomeChat-2B-Instruct');
    expect(models.map((m) => m.id)).not.toContain('onnx-community/turn-detector-GQA-ONNX');
  });

  it('modelInfo defaults unknown ids to q4', () => {
    expect(modelInfo('onnx-community/Custom', CURATED_MODELS)).toMatchObject({ dtype: 'q4', curated: false });
  });
});
