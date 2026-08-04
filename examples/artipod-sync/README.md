# artipod-sync

Playground: https://artipod-bash.os.mieweb.org/

[<img width="250" alt="bash on browser" src="https://github.com/user-attachments/assets/fbaa33c8-790b-461a-8dac-69440c08238c" />](https://youtube.com/shorts/XJp-WK_KTAU?feature=share)

[▶ Demo video](https://youtube.com/shorts/XJp-WK_KTAU?feature=share)

A browser bash + git sandbox: [just-bash](https://github.com/vercel-labs/just-bash) (a full bash interpreter in TypeScript) over a persistent ZenFS filesystem, with isomorphic-git, xterm.js, Monaco, and an LLM agent loop that runs `bash` tool calls inside the same sandbox.

See [just-bash-plan.md](just-bash-plan.md) for the architecture, design decisions, security notes, and phase-by-phase status (the checkboxes there track what is implemented).

## Features

- **Real bash in the browser** — pipes, redirects, globs, vars, loops, ~90 coreutils over ZenFS (IndexedDB or OPFS; files persist across reloads). Tab completion, history, Ctrl+C.
- **Git** — `clone`, `status`, `add`, `commit`, `log`, `branch`, `checkout`, `diff [--staged]`, `fetch`, `pull` (ff-only), `push` (PAT prompt; tokens never touch the sandbox fs). `https://` remotes only, via a configurable CORS proxy.
- **Editor & tree** — Monaco (`edit <file>`) and a file-tree view over the same filesystem.
- **Agent tab** — OpenAI-compatible tool-calling loop (Ozwell et al.); tool calls echo into the terminal; abort button; output truncated to protect context windows.
- **Storage tab** — IndexedDB ⇄ OPFS backend switch with verified migration, usage meter, persistence request, multi-tab write guard.
- **Server parity** — `POST /api/exec` runs the same sandbox core per session (git included) with TTL eviction and hardened limits; `/api/git/*` is a self-hosted git CORS proxy with a host allowlist.

## How to Run

```bash
npm install
npm run dev     # http://localhost:3500
npm test        # vitest suite
```

## Try it

```bash
git clone https://github.com/isomorphic-git/lightning-fs
cd lightning-fs
grep -rn "IndexedDB" . | head -5
edit README.md          # opens Monaco; save, then:
git diff README.md
git add . && git commit -m "notes"
git log --oneline
notes                    # shell semantics & limitations
```

## Configuration

| Env / setting | Purpose |
|---|---|
| `NEXT_PUBLIC_GIT_CORS_PROXY` | Git CORS proxy URL (defaults to the self-hosted `/api/git` route in the browser; no proxy server-side) |
| `GIT_PROXY_ALLOWED_HOSTS` | Comma-separated host allowlist for the self-hosted proxy |
| `EXEC_API_TOKEN` | If set, `POST /api/exec` requires `Authorization: Bearer <token>` |
| Agent tab | OpenAI-compatible base URL, API key, and model (stored in localStorage) |

## Architecture

- **Shell**: just-bash `Bash` behind `lib/sandbox/createSandbox()`; per-line session state (cwd/vars/aliases) reconstructed host-side — see plan §Phase 1.
- **FileSystem**: `@zenfs/core` singleton; just-bash sees it through `lib/sandbox/zenfs-adapter.ts`, isomorphic-git/Monaco/tree use it directly — one store, coherent views.
- **Git**: `lib/git.ts` (`createGitOps`) as a trusted just-bash custom command.
- **Agent**: `lib/agent/` — client, loop, and sandbox-bound tools (OpenAI + MCP serializers).
- **Server**: `lib/server/` + thin route handlers (`/api/exec`, `/api/git/[...path]`).

`lib/sandbox/` and `lib/agent/` are framework-free (no React/Next/window) so they can be extracted for reuse — plan §Phase 6.

## Notes

* Second pass at only-bash was inspired by cloudflare: https://blog.cloudflare.com/cloudflare-computer/ 
