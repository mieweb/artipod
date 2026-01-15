# ArtiPod Examples

This directory contains example applications demonstrating the ArtiPod library.

## Available Examples

### [basic](./basic)

A simple TypeScript script demonstrating the core ArtiPod features:

- Automatic "main" mount creation with random IDs
- Custom pod IDs for persistence
- Pod initialization and reloading
- Creating pods without main mounts
- Adding additional mounts
- Cleanup operations

**Run it:**

```bash
# From the repository root
npm run example:basic

# Or directly
npx ts-node examples/basic/basic-pod-usage.ts
```

### [mcp-server](./mcp-server)

A Model Context Protocol (MCP) server that exposes ArtiPod's AI-aware file operations to VS Code and other MCP clients:

- 8 AI-optimized tools for file operations and command execution
- Lazy pod initialization on first tool call
- Ephemeral containers with automatic cleanup
- Resource providers for pod state and file trees
- VS Code integration ready

**Quick Start:**

```bash
cd mcp-server
npm install
npm run build

# Configure .env with your workspace directory
cp .env.example .env
# Edit .env to set WORKSPACE_DIR

# Test locally (ctrl+c to exit)
npm start
```

See [mcp-server/README.md](./mcp-server/README.md) for VS Code integration setup.

### [web-demo](./web-demo)

A full-stack web application with React frontend and Express backend, featuring:

- Visual filesystem management
- ArtiPod and ArtiMount creation
- File editing across mounts
- Docker container execution
- Interactive bash terminal
- SQLite persistence

**Quick Start:**

```bash
cd web-demo
npm run install:all
npm run dev
```

Then open http://localhost:5173

See [web-demo/README.md](./web-demo/README.md) for detailed documentation.

## Creating New Examples

Examples should:

1. Live in their own subdirectory under `examples/`
2. Have a `package.json` with `"artipod": "file:../.."` dependency
3. Include a README with setup and usage instructions
4. Be marked as `"private": true` to prevent npm publishing

The parent `.gitignore` excludes `examples/**/workspace/` and `examples/**/node_modules/` automatically.
