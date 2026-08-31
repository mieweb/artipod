# AGENTS.md — examples/artipod-sync

Next.js demo app consuming `@artipod/core` (browser pod + terminal + editor + agent panel + manager sync routes). Repo-wide conventions live in the root `.github/copilot-instructions.md`; this file covers what is specific to this app. Formerly the standalone `horner/artipod-sync` repo — imported here with history (sync-demo-plan.md Phase A).

## Tech stack & constraints

- Next.js 14 (App Router), Tailwind CSS; client-side heavy (ZenFS, isomorphic-git, just-bash).
- **NO backend server for git operations.** All git logic runs in the browser; the only server involvement is the CORS proxy at `/api/git` (browser default; `NEXT_PUBLIC_GIT_CORS_PROXY` overrides). The public `cors.isomorphic-git.org` is dead — never default to it.
- `.npmrc` `install-links=true` is load-bearing: the `file:` dep on `@artipod/core` must install as a **copy**, or Next bundles the package's own `@zenfs/core` and page-data collection breaks (`tf is not a constructor`).
- Registry allowlist for the `/api/oci` relay defaults to deny-all; `.env.development` enables docker.io/ghcr.io/quay.io for the hosted demo.

## Deployment: sample site (`artipod-bash`)

- **Detection**: if `hostname` returns `artipod-bash`, this machine is the public sample site.
- **Run a release build, not dev**: `npm run build && npm run start -- -p 3000`. Port 3000 always (`npm run dev -p 3500` is local-only). A load balancer maps `https://artipod-bash.os.mieweb.org` → port 3000.
- **Process manager**: systemd unit `artipod-sync` (source of truth: `deploy/artipod-sync.service`). Deploy: `npm ci && npm run build && sudo systemctl restart artipod-sync`; logs: `journalctl -u artipod-sync -f`.
- **Never run `npm run dev` there while the service is live**: `next dev` overwrites `.next`, the running release build 500s on its own chunks and hangs at "Initializing FileSystem…". Recover with `npm run build && sudo systemctl restart artipod-sync`.
- Generated links/callbacks/CORS origins must use the public HTTPS URL, not `localhost:3000`.
