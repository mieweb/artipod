# ArtiPod MCP Server

Model Context Protocol (MCP) server for [ArtiPod](https://github.com/yourusername/artipod), exposing AI-aware file operations and secure container execution to VS Code and other MCP clients.

## Features

- **8 AI-Optimized Tools** for file operations and command execution
- **Lazy Initialization** - Pod created on first tool call
- **Ephemeral Containers** - Isolated command execution with automatic cleanup
- **Resource Providers** - Access pod state, file trees, and AI context
- **VS Code Compatible** - Works with VS Code's MCP integration
- **Security First** - Seccomp profiles and resource limits for container execution

## Available Tools

### File Operations
- `read_file` - Read file contents with optional line ranges
- `create_file` - Create new files with content
- `list_dir` - List directory contents
- `create_directory` - Create directories recursively

### Edit Operations
- `replace_string_in_file` - Precise string replacement with context matching
- `multi_replace_string_in_file` - Batch multiple replacements
- `apply_patch` - Apply unified diff patches

### Container Execution
- `run_in_terminal` - Execute bash commands in ephemeral sandboxed containers

## Installation

### Prerequisites

- Node.js 18+ and npm
- Docker (or Podman/Lima) installed and running
- VS Code with MCP support

### Setup

1. **Clone and build the artipod project:**

```bash
git clone https://github.com/yourusername/artipod.git
cd artipod
npm install
npm run build
```

2. **Install MCP server dependencies:**

```bash
cd examples/mcp-server
npm install
npm run build
```

3. **Configure environment:**

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```bash
# Directory where pod workspaces will be stored
WORKSPACE_DIR=/path/to/your/workspace

# Optional: Custom pod ID (auto-generated if not provided)
# POD_ID=my-project-pod

# Paths to Dockerfile and seccomp profile (relative to artipod root)
DOCKERFILE_PATH=../../container/Dockerfile
SECCOMP_PROFILE_PATH=../../container/seccomp-profiles/sandbox.json

# Container resource limits (optional)
# CONTAINER_MEMORY_MB=512
# CONTAINER_CPU_COUNT=1
# COMMAND_TIMEOUT_MS=30000
```

## VS Code Integration

### Add to VS Code Settings

Open your VS Code `settings.json` (Cmd/Ctrl + Shift + P → "Preferences: Open User Settings (JSON)") and add:

```json
{
  "mcp.servers": {
    "artipod": {
      "command": "node",
      "args": [
        "/absolute/path/to/artipod/examples/mcp-server/dist/index.js"
      ],
      "env": {
        "WORKSPACE_DIR": "/absolute/path/to/your/workspace",
        "DOCKERFILE_PATH": "/absolute/path/to/artipod/container/Dockerfile",
        "SECCOMP_PROFILE_PATH": "/absolute/path/to/artipod/container/seccomp-profiles/sandbox.json"
      }
    }
  }
}
```

**Important:** Use absolute paths in the VS Code configuration.

### Verify Connection

1. Open VS Code Command Palette (Cmd/Ctrl + Shift + P)
2. Type "MCP: Show Server Status"
3. Verify that "artipod" server is connected

## Usage

### Using Tools in VS Code

Once configured, the ArtiPod tools are available to VS Code's AI assistant. Example interactions:

**Read a file:**
```
Show me the contents of src/index.ts
```
The AI will use the `read_file` tool to fetch the file.

**Create a new file:**
```
Create a new file called hello.ts with a simple hello world function
```
The AI will use the `create_file` tool.

**Run a command:**
```
Run npm test in the container
```
The AI will use the `run_in_terminal` tool, which automatically:
1. Starts an ephemeral Docker container
2. Executes the command
3. Stops and removes the container

**Edit a file:**
```
In src/server.ts, change the port from 3000 to 8080
```
The AI will use `replace_string_in_file` to make the edit.

### Accessing Resources

Resources provide read-only information about the pod:

- `artipod://pod/state` - Pod state (ID, mounts, container status)
- `artipod://pod/tree` - File tree for all mounts
- `artipod://pod/tree/main` - File tree for specific mount
- `artipod://pod/prompt` - AI-formatted context

Resources can be accessed through VS Code's MCP resource browser.

## Architecture

### Lazy Initialization

The pod is **not** created when the server starts. Instead:

1. First tool call triggers pod initialization
2. Pod is created with configured `workspaceDir` and optional `podId`
3. Main mount is created at `workspaceDir/artipod-{podId}/`
4. Subsequent tool calls use the existing pod

This ensures clean startup and allows configuration validation before pod creation.

### Ephemeral Containers

For `run_in_terminal` tool:

1. **Start** - Container is created with:
   - All mounts bound at `/context/{mountName}`
   - Seccomp security profile
   - Resource limits (512MB memory, 1 CPU core)
   - Working directory: `/context/main`

2. **Execute** - Command runs in isolated environment

3. **Cleanup** - Container is stopped and removed automatically

**Performance Note:** Container image is cached, but container creation adds ~1-2 seconds overhead per command.

### Security

- **Path Validation** - All file operations validate paths to prevent traversal attacks
- **Read-Only Mounts** - Additional mounts can be marked read-only
- **Seccomp Profiles** - Limits syscalls available to container processes
- **Resource Limits** - Prevents resource exhaustion
- **No Persistent Containers** - Fresh environment for each command

## File Structure

```
examples/mcp-server/
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript configuration
├── .env.example              # Example configuration
├── README.md                 # This file
└── src/
    ├── index.ts              # Entry point
    ├── server.ts             # MCP server implementation
    ├── config.ts             # Configuration loader
    ├── tools.ts              # Tool manager with lazy init
    └── resources.ts          # Resource providers
```

## Development

### Build

```bash
npm run build
```

### Run Locally

```bash
npm start
```

### Clean Build Artifacts

```bash
npm run clean
```

## Troubleshooting

### "Missing required environment variable: WORKSPACE_DIR"

Ensure `WORKSPACE_DIR` is set in your `.env` file or VS Code settings.

### "Container already running for this pod"

This shouldn't happen with ephemeral containers. If it does, restart the MCP server.

### "No container running"

The container is started automatically when using `run_in_terminal`. If you see this error, check Docker is running.

### "Failed to read resource"

Resources are only available after the pod is initialized (i.e., after first tool call).

## Advanced Configuration

### Custom Pod ID

Set `POD_ID` in `.env` to use a specific pod ID. This allows:
- Persistent pod across server restarts
- Multiple projects with different pod IDs
- Easier debugging and identification

### Multiple Mounts

The MCP server currently creates a single "main" mount. To add additional mounts, you would need to modify `src/tools.ts` to accept mount configuration.

### Container Customization

Modify `CONTAINER_MEMORY_MB`, `CONTAINER_CPU_COUNT`, and `COMMAND_TIMEOUT_MS` to adjust resource limits and timeouts.

## Known Limitations

1. **Single Pod** - One pod per server instance
2. **No Search Tools** - `file_search` and `grep_search` not yet implemented
3. **Ephemeral Only** - No support for persistent containers
4. **Main Mount Only** - Additional mounts require code changes

## Related Projects

- [ArtiPod](https://github.com/yourusername/artipod) - AI-aware file storage library
- [Model Context Protocol](https://github.com/modelcontextprotocol) - Protocol specification
- [VS Code MCP Extension](https://marketplace.visualstudio.com/items?itemName=...) - VS Code integration

## License

Same as the main ArtiPod project.
