'use client';

import { useEffect, useRef, useState } from 'react';
import type { Sandbox } from '@/lib/sandbox/types';
import type { ChatMessage } from '@/lib/agent/types';
import type { LocalModelClient } from '@/lib/agent/local/client';
import { CURATED_MODELS, DEFAULT_LOCAL_MODEL, type LocalModelInfo } from '@/lib/agent/local/model-registry';
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

type Provider = 'remote' | 'local';

interface AgentConfig {
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  localModel: string;
}

const DEFAULT_CONFIG: AgentConfig = {
  provider: 'remote',
  baseUrl: 'http://localhost:3000',
  apiKey: '',
  model: 'gpt-4o-mini',
  localModel: DEFAULT_LOCAL_MODEL,
};

function loadConfig(): { config: AgentConfig; remembered: boolean } {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const config = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
      // a stored key means the user opted into persistence earlier
      return { config, remembered: Boolean(config.apiKey) };
    }
  } catch {
    // fall through
  }
  return { config: DEFAULT_CONFIG, remembered: false };
}

function persistConfig(config: AgentConfig, rememberKey: boolean): void {
  const { apiKey, ...withoutKey } = config;
  localStorage.setItem(CONFIG_KEY, JSON.stringify(rememberKey ? config : withoutKey));
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
  const [rememberKey, setRememberKey] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [localModels, setLocalModels] = useState<LocalModelInfo[]>(CURATED_MODELS);
  const [webGpuOk, setWebGpuOk] = useState(true);
  const [progress, setProgress] = useState('');
  const historyRef = useRef<ChatMessage[]>([{ role: 'system', content: SYSTEM_PROMPT }]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const localClientRef = useRef<{ modelId: string; client: LocalModelClient } | null>(null);

  useEffect(() => {
    const loaded = loadConfig();
    setConfig(loaded.config);
    setRememberKey(loaded.remembered);
    setWebGpuOk('gpu' in navigator);
    import('@/lib/agent/local/model-registry').then(({ listLocalModels }) =>
      listLocalModels().then(setLocalModels).catch(() => undefined),
    );
    return () => localClientRef.current?.client.dispose();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  const saveConfig = (next: AgentConfig) => {
    setConfig(next);
    persistConfig(next, rememberKey);
  };

  const toggleRememberKey = (checked: boolean) => {
    setRememberKey(checked);
    persistConfig(config, checked); // off: strips the key from localStorage immediately
  };

  const append = (item: DisplayItem) => setItems((prev) => [...prev, item]);

  const handleAbort = () => abortRef.current?.abort();

  /** Worker + weights survive across turns; swap only when the model changes. */
  const getLocalClient = async (): Promise<LocalModelClient> => {
    const { LocalModelClient } = await import('@/lib/agent/local/client');
    const { modelInfo } = await import('@/lib/agent/local/model-registry');
    const cached = localClientRef.current;
    if (cached?.modelId === config.localModel) return cached.client;
    cached?.client.dispose();
    const client = new LocalModelClient({
      modelId: config.localModel,
      dtype: modelInfo(config.localModel, localModels).dtype,
      onProgress: (status, file, pct) =>
        setProgress(
          status === 'progress' && pct !== undefined
            ? `Downloading ${file.split('/').pop()} — ${pct.toFixed(0)}%`
            : status === 'done' || status === 'ready'
              ? ''
              : `${status}: ${file.split('/').pop()}`,
        ),
    });
    localClientRef.current = { modelId: config.localModel, client };
    return client;
  };

  const handleSend = async () => {
    const question = input.trim();
    const sandbox = getSandbox();
    if (!question || running || !sandbox) return;
    if (config.provider === 'remote' && !config.apiKey) {
      setShowConfig(true);
      append({ kind: 'error', text: 'Set the API endpoint and key first.' });
      return;
    }
    if (config.provider === 'local' && !webGpuOk) {
      append({ kind: 'error', text: 'WebGPU is not available in this browser — local ONNX models need it.' });
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

      const client =
        config.provider === 'local'
          ? await getLocalClient()
          : new OzwellClient({
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
      setProgress('');
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
          {config.provider === 'local'
            ? `Local ONNX · ${config.localModel.replace('onnx-community/', '')}`
            : `${config.baseUrl} · ${config.model}`}{' '}
          ▾
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
          <label className="flex flex-col gap-1 sm:col-span-3">
            <span className="text-gray-400">Provider</span>
            <select
              value={config.provider}
              onChange={(e) => saveConfig({ ...config, provider: e.target.value as Provider })}
              className="w-fit rounded bg-[#1e1e1e] border border-gray-600 px-2 py-1"
            >
              <option value="remote">Remote API (OpenAI-compatible)</option>
              <option value="local">Local — in-browser ONNX (WebGPU)</option>
            </select>
          </label>

          {config.provider === 'local' ? (
            <>
              <label className="flex flex-col gap-1 sm:col-span-3">
                <span className="text-gray-400">Local model (Hugging Face Hub · onnx-community)</span>
                <select
                  value={config.localModel}
                  onChange={(e) => saveConfig({ ...config, localModel: e.target.value })}
                  className="rounded bg-[#1e1e1e] border border-gray-600 px-2 py-1"
                >
                  {localModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {m.approxSize ? ` · ${m.approxSize}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <p className="sm:col-span-3 text-[11px] leading-snug text-gray-500">
                Weights download once from the Hugging Face Hub and are cached in this
                browser&apos;s origin-private file system under artipod-models/ — a sibling of the
                sandbox mount (artipod-fs/), so agent tool calls cannot read or delete them. No
                API key; nothing leaves the machine after the download.
                {!webGpuOk && (
                  <span className="block text-red-400">
                    WebGPU is not available in this browser — local models will not run.
                  </span>
                )}
              </p>
            </>
          ) : (
            <>
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
              <label className="flex items-start gap-2 sm:col-span-3">
                <input
                  type="checkbox"
                  checked={rememberKey}
                  onChange={(e) => toggleRememberKey(e.target.checked)}
                  aria-describedby="agent-key-storage-note"
                  className="mt-0.5"
                />
                <span className="text-gray-400">
                  Remember API key in this browser
                  <span id="agent-key-storage-note" className="block text-[11px] leading-snug text-gray-500">
                    Off (default): the key is held only in this tab&apos;s memory and is forgotten when
                    you close or reload the page. On: it is saved as plaintext in this browser&apos;s
                    localStorage for this site only. In both cases the key is never written to the
                    sandbox filesystem (ZenFS), so agent tool calls like bash or read_file cannot see
                    it — only requests to the base URL above carry it.
                  </span>
                </span>
              </label>
            </>
          )}
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

      {progress && (
        <p className="border-t border-gray-700 px-3 py-1 text-xs text-gray-400" aria-live="polite">
          {progress}
        </p>
      )}

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
