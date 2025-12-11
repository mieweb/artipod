# ArtiPod Examples

This directory contains example applications demonstrating the ArtiPod library.

## Available Examples

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
