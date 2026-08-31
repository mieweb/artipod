/**
 * Pod-level tools - container command execution
 * 
 * These tools operate at the ArtiPod level (across all mounts) rather than
 * on individual ArtiMounts. They provide container command execution capabilities.
 */

import { ArtiPod } from '../artipod.js';
import type { CommandResult } from '../docker/containerUtils.js';
import {
  ToolHandler,
  ToolName,
  ToolResult,
  ToolDefinition,
  IRunInTerminalParams,
} from './types.js';
import { runInTerminalDefinition } from './definitions.js';
import { BashTool, BashExecutor, containerBashExecutor } from './bashTool.js';
import { createPodFileTools, MountTableEntry, PodPathResolver } from './podFileTools.js';
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
 * Options for the pod-level tool registry.
 */
export interface PodToolRegistryOptions {
  /**
   * Mount table for pod-level file tools. Core enforces no prefix scheme:
   * the application declares each mount's absolute path (Decision #3).
   * When provided, the VS Code-schema file tools (read_file, create_file,
   * list_dir, create_directory, replace_string_in_file,
   * multi_replace_string_in_file, apply_patch) are registered pod-wide.
   */
  mountTable?: MountTableEntry[];
  /**
   * bash execution backend. Defaults to the pod's running container
   * (docker backend); Phase 2 injects the just-bash sandbox here.
   */
  bashExecutor?: BashExecutor;
}

/**
 * Pod-level tool registry: container execution, bash, and (with a mount
 * table) pod-wide file tools resolved against each mount's declared path.
 */
export class PodToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();

  constructor(pod: ArtiPod, options?: PodToolRegistryOptions) {
    // Register all pod-level tools
    this.register(new RunTerminalTool(pod));
    this.register(new BashTool(options?.bashExecutor ?? containerBashExecutor(pod)));
    if (options?.mountTable?.length) {
      const resolver = new PodPathResolver(options.mountTable);
      for (const tool of createPodFileTools(resolver)) {
        this.register(tool);
      }
    }
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
export function createPodToolRegistry(pod: ArtiPod, options?: PodToolRegistryOptions): PodToolRegistry {
  return new PodToolRegistry(pod, options);
}

/**
 * Create all pod-level tools for a pod (returns array of handlers)
 */
export function createPodTools(pod: ArtiPod, options?: PodToolRegistryOptions): ToolHandler[] {
  const tools: ToolHandler[] = [
    new RunTerminalTool(pod),
    new BashTool(options?.bashExecutor ?? containerBashExecutor(pod)),
  ];
  if (options?.mountTable?.length) {
    tools.push(...createPodFileTools(new PodPathResolver(options.mountTable)));
  }
  return tools;
}
