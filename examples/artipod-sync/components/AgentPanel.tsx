'use client';

import { useEffect, useRef, useState } from 'react';
import type { Sandbox } from '@/lib/sandbox/types';
import type { ChatMessage } from '@/lib/agent/types';
import { Send, Square } from 'lucide-react';

interface AgentPanelProps {
  getSandbox: () => Sandbox | null;
  /** Mirrors agent tool calls into the xterm terminal. */
  echoToTerminal?: (text: string) => void;
}

interface DisplayItem {
  kind: 'user' | 'assistant' | 'tool' | 'error' | 'info';
  text: string;
}

const CONFIG_KEY = 'artipod-sync-agent-config';

interface AgentConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  baseUrl: 'http://localhost:3000',
  apiKey: '',
  model: 'gpt-4o-mini',
};

function loadConfig(): AgentConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    // fall through
  }
  return DEFAULT_CONFIG;
}

const SYSTEM_PROMPT = `You are a coding agent operating inside a browser sandbox.
You have a persistent bash shell over a virtual filesystem (ZenFS). The working
directory /repo may contain a git repository; 'git' (clone/status/add/commit/
log/branch/checkout/diff/push...) and ~90 coreutils are available via the bash
tool. cwd, variables and aliases persist between bash calls; shell functions do
not. Prefer read_file/write_file/list_files over cat/echo for file content.
Keep commands non-interactive (no pagers or prompts).`;

export default function AgentPanel({ getSandbox, echoToTerminal }: AgentPanelProps) {
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_CONFIG);
  const [showConfig, setShowConfig] = useState(false);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const historyRef = useRef<ChatMessage[]>([{ role: 'system', content: SYSTEM_PROMPT }]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setConfig(loadConfig());
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  const saveConfig = (next: AgentConfig) => {
    setConfig(next);
    localStorage.setItem(CONFIG_KEY, JSON.stringify(next));
  };

  const append = (item: DisplayItem) => setItems((prev) => [...prev, item]);

  const handleAbort = () => abortRef.current?.abort();

  const handleSend = async () => {
    const question = input.trim();
    const sandbox = getSandbox();
    if (!question || running || !sandbox) return;
    if (!config.apiKey) {
      setShowConfig(true);
      append({ kind: 'error', text: 'Set the API endpoint and key first.' });
      return;
    }

    setInput('');
    append({ kind: 'user', text: question });
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const [{ OzwellClient }, { ToolCallingLoop }, { createSandboxTools }] = await Promise.all([
        import('@/lib/agent/ozwell-client'),
        import('@/lib/agent/loop'),
        import('@/lib/agent/tools'),
      ]);

      const client = new OzwellClient({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        defaultModel: config.model,
      });
      const loop = new ToolCallingLoop(client, createSandboxTools(sandbox));

      historyRef.current.push({ role: 'user', content: question });
      const result = await loop.runWithHistory(historyRef.current, {
        signal: controller.signal,
        onAssistantMessage: (content) => append({ kind: 'assistant', text: content }),
        onToolCall: (call) => {
          let display = call.function.arguments;
          try {
            const args = JSON.parse(call.function.arguments || '{}');
            display = call.function.name === 'bash' ? String(args.command ?? '') : JSON.stringify(args);
          } catch {
            // keep raw arguments
          }
          append({ kind: 'tool', text: `$ ${display}` });
          echoToTerminal?.(`\r\n\x1b[2m[agent] $ ${display}\x1b[0m\r\n`);
        },
        onToolResult: (call, result) => {
          if (call.function.name === 'bash' && result.success) {
            try {
              const parsed = JSON.parse(result.content);
              if (parsed.stdout) echoToTerminal?.(parsed.stdout.replace(/\r?\n/g, '\r\n'));
              if (parsed.stderr) echoToTerminal?.(`\x1b[31m${parsed.stderr.replace(/\r?\n/g, '\r\n')}\x1b[0m`);
            } catch {
              // non-JSON tool output: skip terminal echo
            }
          }
          if (!result.success) append({ kind: 'error', text: result.error ?? 'tool failed' });
        },
      });
      historyRef.current = result.messages;
      append({ kind: 'info', text: `done in ${result.iterations} step${result.iterations === 1 ? '' : 's'}` });
    } catch (e) {
      append({ kind: 'error', text: (e as Error).message });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  return (
    <section aria-label="Agent chat" className="flex h-full w-full flex-col bg-[#1e1e1e] text-white">
      <div className="flex items-center justify-between border-b border-gray-700 bg-[#2d2d2d] px-3 py-2">
        <h2 className="text-sm font-bold">Agent</h2>
        <button
          onClick={() => setShowConfig((v) => !v)}
          className="text-xs text-gray-400 hover:text-gray-200"
          aria-expanded={showConfig}
        >
          {config.baseUrl} · {config.model} ▾
        </button>
      </div>

      {showConfig && (
        <form
          className="grid grid-cols-1 gap-2 border-b border-gray-700 bg-[#252525] p-3 text-xs sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            setShowConfig(false);
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">Base URL (OpenAI-compatible)</span>
            <input
              value={config.baseUrl}
              onChange={(e) => saveConfig({ ...config, baseUrl: e.target.value })}
              className="rounded bg-[#1e1e1e] border border-gray-600 px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">API key</span>
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => saveConfig({ ...config, apiKey: e.target.value })}
              className="rounded bg-[#1e1e1e] border border-gray-600 px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-400">Model</span>
            <input
              value={config.model}
              onChange={(e) => saveConfig({ ...config, model: e.target.value })}
              className="rounded bg-[#1e1e1e] border border-gray-600 px-2 py-1"
            />
          </label>
        </form>
      )}

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-auto p-3 text-sm" aria-live="polite">
        {items.length === 0 && (
          <p className="text-gray-500">
            Ask for something like: “clone https://github.com/isomorphic-git/lightning-fs and summarize
            the README, then count the JS files”. Tool calls appear here and in the terminal.
          </p>
        )}
        {items.map((item, i) => (
          <div
            key={i}
            className={
              item.kind === 'user'
                ? 'rounded bg-blue-950 px-3 py-2'
                : item.kind === 'assistant'
                  ? 'rounded bg-[#2a2a2a] px-3 py-2 whitespace-pre-wrap'
                  : item.kind === 'tool'
                    ? 'px-3 font-mono text-xs text-gray-400'
                    : item.kind === 'error'
                      ? 'px-3 text-xs text-red-400'
                      : 'px-3 text-xs text-gray-500'
            }
          >
            {item.text}
          </div>
        ))}
      </div>

      <div className="flex gap-2 border-t border-gray-700 p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={running ? 'Agent is working…' : 'Ask the agent…'}
          disabled={running}
          aria-label="Message for the agent"
          className="flex-1 rounded bg-[#2a2a2a] border border-gray-600 px-3 py-2 text-sm disabled:opacity-50"
        />
        {running ? (
          <button
            onClick={handleAbort}
            className="flex items-center gap-1 rounded bg-red-700 px-3 py-2 text-sm hover:bg-red-600"
            aria-label="Stop the agent"
          >
            <Square size={14} /> Stop
          </button>
        ) : (
          <button
            onClick={handleSend}
            className="flex items-center gap-1 rounded bg-blue-700 px-3 py-2 text-sm hover:bg-blue-600 disabled:opacity-40"
            disabled={!input.trim()}
            aria-label="Send message"
          >
            <Send size={14} /> Send
          </button>
        )}
      </div>
    </section>
  );
}
