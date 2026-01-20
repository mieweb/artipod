import { ArtiPod, ArtiMount, MountToolRegistry, PodToolRegistry, ToolResult } from 'artipod';
import type { ServerConfig } from './config.js';

/**
 * Manages tool execution with lazy pod initialization and ephemeral containers
 */
export class ToolManager {
  private pod: ArtiPod | null = null;
  private mountToolRegistry: MountToolRegistry | null = null;
  private podToolRegistry: PodToolRegistry | null = null;
  private readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  /**
   * Initialize pod lazily on first tool call
   */
  private async ensurePodInitialized(): Promise<void> {
    if (this.pod) {
      return;
    }

    // Create pod with optional custom ID
    const podOptions = {
      workspaceDir: this.config.workspaceDir,
      id: this.config.podId,
      useMainMount: true,
    };

    this.pod = new ArtiPod(podOptions);
    await this.pod.initialize();

    // Create tool registries
    const mainMount = this.pod.getMount('main');
    if (!mainMount) {
      throw new Error('Failed to get main mount after pod initialization');
    }

    this.mountToolRegistry = new MountToolRegistry(mainMount);
    this.podToolRegistry = new PodToolRegistry(this.pod);
  }

  /**
   * Execute a tool with automatic pod initialization
   */
  async executeTool(toolName: string, params: unknown): Promise<ToolResult> {
    // Special handling for run_in_terminal with ephemeral containers
    if (toolName === 'run_in_terminal') {
      return this.executeWithEphemeralContainer(params);
    }

    // Ensure pod is initialized
    await this.ensurePodInitialized();

    // Try mount tools first
    const mountTool = this.mountToolRegistry?.get(toolName);
    if (mountTool) {
      try {
        return await mountTool.execute(params);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    // Try pod tools
    const podTool = this.podToolRegistry?.get(toolName);
    if (podTool) {
      try {
        return await podTool.execute(params);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      success: false,
      error: `Tool not found: ${toolName}`,
    };
  }

  /**
   * Execute run_in_terminal with ephemeral container
   * Starts container before execution, stops after completion
   */
  private async executeWithEphemeralContainer(params: unknown): Promise<ToolResult> {
    await this.ensurePodInitialized();

    if (!this.pod) {
      return {
        success: false,
        error: 'Pod initialization failed',
      };
    }

    let containerStarted = false;

    try {
      // Start ephemeral container
      await this.pod.startContainer(this.config.dockerfilePath, {
        seccompProfilePath: this.config.seccompProfilePath,
        memory: this.config.containerMemoryMB * 1024 * 1024, // Convert MB to bytes
        nanoCpus: this.config.containerCpuCount * 1e9, // Convert CPU count to nano CPUs
        commandTimeout: this.config.commandTimeoutMs,
      });
      containerStarted = true;

      // Execute command
      const podTool = this.podToolRegistry?.get('run_in_terminal');
      if (!podTool) {
        return {
          success: false,
          error: 'run_in_terminal tool not found',
        };
      }

      const result = await podTool.execute(params);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Always stop and remove container
      if (containerStarted && this.pod.hasContainer()) {
        try {
          await this.pod.stopContainer();
        } catch (error) {
          // Log but don't fail the tool execution
          console.error('Failed to stop container:', error);
        }
      }
    }
  }

  /**
   * Get all available tool definitions
   */
  getToolDefinitions() {
    // Return static definitions without initializing pod
    // These match the tools that will be available after lazy init
    return [
      // Mount tools (from MountToolRegistry)
      {
        name: 'read_file',
        description: 'Read the contents of a file with optional line range',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'The absolute or relative path to the file',
            },
            startLine: {
              type: 'number',
              description: 'The starting line number (1-indexed, optional)',
            },
            endLine: {
              type: 'number',
              description: 'The ending line number (1-indexed, optional)',
            },
          },
          required: ['filePath'],
        },
      },
      {
        name: 'create_file',
        description: 'Create a new file with content',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'The absolute or relative path for the new file',
            },
            content: {
              type: 'string',
              description: 'The content to write to the file',
            },
          },
          required: ['filePath', 'content'],
        },
      },
      {
        name: 'list_dir',
        description: 'List the contents of a directory',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'The absolute or relative path to the directory',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'create_directory',
        description: 'Create a directory recursively',
        inputSchema: {
          type: 'object',
          properties: {
            dirPath: {
              type: 'string',
              description: 'The absolute or relative path for the new directory',
            },
          },
          required: ['dirPath'],
        },
      },
      {
        name: 'replace_string_in_file',
        description: 'Replace a string in a file with exact matching',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'The absolute or relative path to the file',
            },
            oldString: {
              type: 'string',
              description: 'The exact string to replace (must match exactly)',
            },
            newString: {
              type: 'string',
              description: 'The new string to replace with',
            },
          },
          required: ['filePath', 'oldString', 'newString'],
        },
      },
      {
        name: 'multi_replace_string_in_file',
        description: 'Perform multiple string replacements in one call',
        inputSchema: {
          type: 'object',
          properties: {
            replacements: {
              type: 'array',
              description: 'Array of replacement operations',
              items: {
                type: 'object',
                properties: {
                  filePath: { type: 'string' },
                  oldString: { type: 'string' },
                  newString: { type: 'string' },
                  explanation: { type: 'string' },
                },
                required: ['filePath', 'oldString', 'newString'],
              },
            },
          },
          required: ['replacements'],
        },
      },
      {
        name: 'apply_patch',
        description: 'Apply a unified diff patch to files',
        inputSchema: {
          type: 'object',
          properties: {
            patch: {
              type: 'string',
              description: 'The unified diff format patch to apply',
            },
          },
          required: ['patch'],
        },
      },
      // Pod tools (from PodToolRegistry)
      {
        name: 'run_in_terminal',
        description: 'Execute a bash command in an isolated container (ephemeral)',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The bash command to execute',
            },
            timeout: {
              type: 'number',
              description: 'Timeout in milliseconds (default: 30000)',
            },
          },
          required: ['command'],
        },
      },
    ];
  }

  /**
   * Get the pod instance (may be null if not yet initialized)
   */
  getPod(): ArtiPod | null {
    return this.pod;
  }

  /**
   * Check if pod is initialized
   */
  isInitialized(): boolean {
    return this.pod !== null;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.pod && this.pod.hasContainer()) {
      try {
        await this.pod.stopContainer();
      } catch (error) {
        console.error('Failed to stop container during cleanup:', error);
      }
    }
  }
}
