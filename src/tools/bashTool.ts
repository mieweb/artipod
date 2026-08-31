/**
 * bash tool — schema + 16 KiB truncation semantics ported from
 * artipod-sync lib/agent/tools.ts. Execution is delegated to an injected
 * BashExecutor: the docker backend today, the just-bash sandbox in Phase 2.
 */

import type { ArtiPod } from '../artipod.js';
import {
  ToolDefinition,
  ToolHandler,
  ToolName,
  ToolResult,
  IBashParams,
} from './types.js';
import { truncateOutput } from './truncation.js';

export interface BashExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BashExecutor {
  exec(command: string, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<BashExecutionResult>;
}

export const bashDefinition: ToolDefinition = {
  name: ToolName.Bash,
  description:
    'Execute a bash command in the pod (pipes, globs, redirects). Output is truncated to 16 KiB.',
  inputSchema: {
    type: 'object',
    required: ['command'],
    properties: {
      command: { type: 'string', description: 'The bash command line to execute' },
    },
  },
};

export interface BashToolResult extends ToolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class BashTool implements ToolHandler<IBashParams, BashToolResult> {
  readonly name = ToolName.Bash;
  readonly definition = bashDefinition;

  constructor(private executor: BashExecutor) {}

  async execute(params: IBashParams): Promise<BashToolResult> {
    const command = typeof params?.command === 'string' ? params.command : '';
    if (!command.trim()) {
      return { success: false, error: 'missing "command"', content: '', stdout: '', stderr: '', exitCode: -1 };
    }
    try {
      const r = await this.executor.exec(command);
      // LLM-facing content: JSON body with truncated streams (sync semantics)
      const content = JSON.stringify({
        stdout: truncateOutput(r.stdout),
        stderr: truncateOutput(r.stderr),
        exitCode: r.exitCode,
      });
      return { success: r.exitCode === 0, content, stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        content: '',
        stdout: '',
        stderr: '',
        exitCode: -1,
      };
    }
  }
}

/** BashExecutor backed by the pod's running container (docker backend). */
export function containerBashExecutor(pod: ArtiPod): BashExecutor {
  return {
    async exec(command, options) {
      if (!pod.hasContainer()) {
        throw new Error(
          'No container running. Start the container first with pod.startContainer(), or inject a sandbox-backed BashExecutor.'
        );
      }
      const r = await pod.executeCommand(command, options?.timeoutMs);
      return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
    },
  };
}
