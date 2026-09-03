# ArtiPod Examples

This directory contains example applications demonstrating the ArtiPod library.

## Available Examples

### [artipod-spa](./artipod-spa)

The hosted example implementation (bundled into the npm package as `dist-ui` —
`npx artipod serve` ships it): a static-exported SPA where the whole pod runs in
your browser — terminal (just-bash), kerebron editor, file tree, agent panel —
with **`artipod serve` as its only backend**. State is zustand snapshots over a
framework-free client-services layer (keys/leases, pod sessions, sync — see
`lib/services/`). True no-reload navigation between workspaces; `artipod ps` in
every shell shows the client's live schedule.

**Run it:**

```bash
# terminal 1 — the backend (from the repository root)
node dist/cli.js serve --port 2784

# terminal 2 — the app (dev rewrites proxy /api to serve)
cd examples/artipod-spa
npm ci
npm run dev   # http://localhost:3600
```

See its [AGENTS.md](./artipod-spa/AGENTS.md) (dev loop, landmines, sample-site
deployment runbook). The previous Next.js implementation (`artipod-sync`, with
its own API routes) was retired at spa-ui-plan U7 — history is in git.

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

### web-demo (retired)

The former full-stack web demo (React + Express + SQLite) is archived at [`attic/web-demo`](../attic/web-demo/). It is superseded by the Phase 6 north-star demo of the [artipod layer plan](../artipod-layer-plan.md): browser demo pod → clone → push/pull to a server → snapshot/compact.

## Creating New Examples

Examples should:

1. Live in their own subdirectory under `examples/`
2. Have a `package.json` with `"artipod": "file:../.."` dependency
3. Include a README with setup and usage instructions
4. Be marked as `"private": true` to prevent npm publishing

The parent `.gitignore` excludes `examples/**/workspace/` and `examples/**/node_modules/` automatically.
