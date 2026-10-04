import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerConfig } from './config.js';
import { ToolManager } from './tools.js';
import {
  getPodState,
  getFileTree,
  getPromptContext,
  type PodStateResource,
  type FileTreeResource,
  type PromptContextResource,
} from './resources.js';

/**
 * ArtiPod MCP Server
 * Exposes AI-aware file operations and container execution via Model Context Protocol
 */
export class ArtiPodMCPServer {
  private server: Server;
  private toolManager: ToolManager;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
    this.toolManager = new ToolManager(config);

    // Initialize MCP server
    this.server = new Server(
      {
        name: 'artipod-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.setupHandlers();
  }

  /**
   * Setup MCP protocol handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.toolManager.getToolDefinitions();
      return { tools };
    });

    // Execute tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        console.error(`[ArtiPod MCP] Executing tool: ${name} with args:`, JSON.stringify(args, null, 2));
        const result = await this.toolManager.executeTool(name, args || {});
        console.error(`[ArtiPod MCP] Tool ${name} result:`, JSON.stringify(result, null, 2));

        // Format response according to MCP spec
        if (result.success) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${result.error || 'Unknown error'}`,
              },
            ],
            isError: true,
          };
        }
      } catch (error) {
        console.error(`[ArtiPod MCP] Exception executing tool ${name}:`, error);
        return {
          content: [
            {
              type: 'text',
              text: `Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });

    // List available resources
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = [
        {
          uri: 'artipod://pod/state',
          name: 'Pod State',
          description: 'Current state of the ArtiPod including mounts and container status',
          mimeType: 'application/json',
        },
        {
          uri: 'artipod://pod/tree',
          name: 'File Tree',
          description: 'Complete file tree for all mounts',
          mimeType: 'text/plain',
        },
        {
          uri: 'artipod://pod/prompt',
          name: 'Prompt Context',
          description: 'AI-formatted context for the entire pod',
          mimeType: 'text/plain',
        },
      ];

      return { resources };
    });

    // Read resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      try {
        if (uri === 'artipod://pod/state') {
          const state = await getPodState(this.toolManager.getPod());
          return {
            contents: [
              {
                uri,
                mimeType: 'application/json',
                text: JSON.stringify(state, null, 2),
              },
            ],
          };
        }

        if (uri === 'artipod://pod/tree') {
          const trees = await getFileTree(this.toolManager.getPod());
          const text = trees.map((t) => `${t.path}:\n${t.tree}`).join('\n\n');
          return {
            contents: [
              {
                uri,
                mimeType: 'text/plain',
                text,
              },
            ],
          };
        }

        if (uri === 'artipod://pod/prompt') {
          const context = await getPromptContext(this.toolManager.getPod());
          return {
            contents: [
              {
                uri,
                mimeType: 'text/plain',
                text: context?.prompt || '(Pod not initialized)',
              },
            ],
          };
        }

        // Support mount-specific tree queries: artipod://pod/tree/main
        if (uri.startsWith('artipod://pod/tree/')) {
          const mountName = uri.substring('artipod://pod/tree/'.length);
          const trees = await getFileTree(this.toolManager.getPod(), mountName);
          if (trees.length === 0) {
            throw new Error(`Mount not found: ${mountName}`);
          }
          return {
            contents: [
              {
                uri,
                mimeType: 'text/plain',
                text: trees[0].tree,
              },
            ],
          };
        }

        throw new Error(`Unknown resource URI: ${uri}`);
      } catch (error) {
        throw new Error(
          `Failed to read resource: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  /**
   * Start the MCP server with stdio transport
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Setup graceful shutdown
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });

    console.error('ArtiPod MCP Server started');
    console.error(`Workspace: ${this.config.workspaceDir}`);
    console.error(`Pod ID: ${this.config.podId || '(auto-generated)'}`);
  }

  /**
   * Cleanup resources on shutdown
   */
  private async cleanup(): Promise<void> {
    console.error('Shutting down ArtiPod MCP Server...');
    await this.toolManager.cleanup();
    await this.server.close();
  }
}
