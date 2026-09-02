# Copilot Instructions for artipod

## Before Committing

Always run these commands before committing changes:

```bash
npm run lint    # Check for linting errors
npm run build   # Compile TypeScript
npm run test    # Run the test suite
```

All three must pass before committing.

## Releasing

Two npm packages ship together: `@artipod/core` (this repo root, the canonical library) and `artipod` (`packages/artipod`, a thin CLI alias that pins `^<core version>`). Both carry the same version. Tags are unprefixed (`0.6.0`, not `v0.6.0`).

1. Roll the `Unreleased` section of `CHANGELOG.md` into a `## [X.Y.Z] - YYYY-MM-DD` heading.
2. Bump `version` in `package.json` AND in `packages/artipod/package.json`, and update the shim's `@artipod/core` dependency to `^X.Y.Z`.
3. Run the pre-commit checks (lint, build, test — build before test: CLI tests spawn `dist/cli.js`).
4. Commit (`chore: release X.Y.Z`), tag `X.Y.Z`, push branch and tag: `git push origin main X.Y.Z`. Pushing a tag alone does NOT publish.
5. Create a GitHub Release for the tag — `.github/workflows/publish.yml` then builds, tests, and publishes `@artipod/core` followed by `artipod` via npm trusted publishing (OIDC, no token). Each publish is skipped if that version is already on the registry, so re-created releases are safe.
6. After core is on the registry, regenerate the shim lockfile so it doesn't resurrect the old dependency tree: `cd packages/artipod && rm package-lock.json node_modules -rf && npm install`, then commit the lockfile (`chore: regenerate shim lockfile post-X.Y.Z`).

Manual publishing (fallback only): `npm publish --access public` in the root, then in `packages/artipod`. It authenticates via the browser — never pipe or wrap the command.

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
