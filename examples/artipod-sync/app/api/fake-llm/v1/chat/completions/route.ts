import { NextResponse } from 'next/server';

/**
 * Scripted fake LLM (dev/e2e only — plan Decision #8: no real AI in tests).
 * Speaks just enough OpenAI chat-completions for the agent loop: first turn
 * returns two tool calls (create_file + bash), the follow-up turn finishes.
 * Point the Agent panel at baseUrl http://localhost:3500/api/fake-llm.
 */
export const dynamic = 'force-dynamic';

interface FakeMessage {
  role: string;
  content?: string | null;
}

export async function POST(req: Request) {
  const body = (await req.json()) as { messages?: FakeMessage[] };
  const hasToolResults = (body.messages ?? []).some((m) => m.role === 'tool');

  const message = hasToolResults
    ? {
        role: 'assistant',
        content: 'done: created /repo/agent-made.txt and measured it (scripted fake, no model involved)',
      }
    : {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'fake-1',
            type: 'function',
            function: {
              name: 'create_file',
              arguments: JSON.stringify({
                filePath: '/repo/agent-made.txt',
                content: 'from the scripted fake agent\n',
              }),
            },
          },
          {
            id: 'fake-2',
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({ command: 'wc -c /repo/agent-made.txt' }),
            },
          },
        ],
      };

  return NextResponse.json({
    id: 'fake-completion',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'scripted-fake',
    choices: [{ index: 0, message, finish_reason: hasToolResults ? 'stop' : 'tool_calls' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}
