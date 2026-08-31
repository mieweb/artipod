# Copilot Instructions for artipod

## Before Committing

Always run these commands before committing changes:

```bash
npm run lint    # Check for linting errors
npm run build   # Compile TypeScript
npm run test    # Run the test suite
```

All three must pass before committing.

## Project Overview

artipod is a TypeScript module for managing AI-aware file storage with ArtiPods and ArtiMounts. It provides vscode-copilot-chat compatible tools for file operations.

## Code Style

- Use TypeScript strict mode
- Follow existing ESLint configuration
- Prefer explicit types over `any`
- Use async/await for asynchronous operations

## Testing

- Tests are located in `src/__tests__/`
- Use Jest for testing
- Run `npm run test:watch` during development
- Run `npm run test:coverage` to check coverage

## Project Structure

- `src/` - Main source code
- `src/tools/` - vscode-copilot-chat compatible tool implementations
- `src/prompts/` - AI prompt templates
- `examples/` - Example applications (`examples/artipod-sync` is the hosted Next.js demo — it has its own `AGENTS.md` with app-specific constraints and the sample-site deployment runbook)
- `container/` - Docker container configuration
