/**
 * Pod-level tools - container command execution
 * 
 * These tools operate at the ArtiPod level (across all mounts) rather than
 * on individual ArtiMounts. They provide container command execution capabilities.
 */

import { ArtiPod } from '../artipod.js';
import { CommandResult } from '../containerUtils.js';
import {
  ToolHandler,
  ToolName,
  ToolResult,
  ToolDefinition,
  IRunInTerminalParams,
} from './types.js';
import { runInTerminalDefinition } from './definitions.js';

/**
 * run_in_terminal tool - execute bash commands in container
 */
export class RunTerminalTool implements ToolHandler<IRunInTerminalParams, CommandResult & ToolResult> {
  readonly name = ToolName.RunTerminal;
  readonly definition = runInTerminalDefinition;

  constructor(private pod: ArtiPod) {}

  async execute(params: IRunInTerminalParams): Promise<CommandResult & ToolResult> {
    // Validate command
    if (!params.command || typeof params.command !== 'string' || !params.command.trim()) {
      return {
        success: false,
        error: 'Command is required and cannot be empty',
        stdout: '',
        stderr: '',
        exitCode: -1,
      };
    }

    // Check if container is running
    if (!this.pod.hasContainer()) {
      return {
        success: false,
        error: 'No container running. Start the container first with pod.startContainer()',
        stdout: '',
        stderr: '',
        exitCode: -1,
      };
    }

    // Clamp timeout if provided
    let timeout: number | undefined;
    if (params.timeout !== undefined) {
      if (typeof params.timeout !== 'number' || params.timeout < 0) {
        return {
          success: false,
          error: 'Timeout must be a positive number (milliseconds)',
          stdout: '',
          stderr: '',
          exitCode: -1,
        };
      }
      
      // Clamp to 1 second - 5 minutes range
      const MIN_TIMEOUT = 1000;
      const MAX_TIMEOUT = 300000;
      timeout = Math.min(Math.max(params.timeout, MIN_TIMEOUT), MAX_TIMEOUT);
    }

    // Execute command
    try {
      const result = await this.pod.executeCommand(params.command, timeout);
      return {
        ...result,
        success: result.exitCode === 0,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        stdout: '',
        stderr: '',
        exitCode: -1,
      };
    }
  }
}

/**
 * Pod-level tool registry for container operations
 */
export class PodToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();

  constructor(pod: ArtiPod) {
    // Register all pod-level tools
    this.register(new RunTerminalTool(pod));
  }

  /**
   * Register a tool handler
   */
  register(tool: ToolHandler): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Get a tool handler by name
   */
  get(name: ToolName | string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool handlers
   */
  getAll(): ToolHandler[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get all tool definitions (for OpenAI function calling format)
   */
  getDefinitions(): ToolDefinition[] {
    return this.getAll().map(tool => tool.definition);
  }

  /**
   * Execute a tool by name with given parameters
   */
  async execute(name: ToolName | string, params: unknown): Promise<ToolResult> {
    const tool = this.get(name);
    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${name}`,
      };
    }

    try {
      return await tool.execute(params);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check if a tool is registered
   */
  has(name: ToolName | string): boolean {
    return this.tools.has(name);
  }
}

/**
 * Create a pod tool registry for a pod
 */
export function createPodToolRegistry(pod: ArtiPod): PodToolRegistry {
  return new PodToolRegistry(pod);
}

/**
 * Create all pod-level tools for a pod (returns array of handlers)
 */
export function createPodTools(pod: ArtiPod): ToolHandler[] {
  return [
    new RunTerminalTool(pod),
  ];
}
