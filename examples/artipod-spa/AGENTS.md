# artipod-spa — agent notes

The SPA rewrite of the artipod demo. **Read `../../spa-ui-plan.md` first** —
it is the living plan (decisions P1–P10, phases U0–U7) and this app must not
drift from it. The old app (`../artipod-sync`) remains the shipped `dist-ui`
until the U7 cutover; do not break it.

## Architecture (plan §4)

- Backend: `artipod serve` ONLY. No `app/api` here, ever (P2).
- State: vanilla zustand stores (serializable snapshots) over a framework-free
  services layer (`lib/services/` — the future client lib, D2). Live objects
  (pods, sandboxes, CryptoKeys) never enter a store; key material never enters
  a persisted store (P4).
- Components: @mieweb/ui, themed via `--mieweb-*` tokens only — never generic
  shadcn vars (P5). Verify dark mode before any UI gate.

## Dev loop

```bash
# terminal 1 — the backend (from the repo root; --encrypt is the hard case)
node dist/cli.js serve --port 2784 --encrypt

# terminal 2 — the app; /api/* and /v2/* proxy to serve (dev-only rewrites)
npm run dev            # http://localhost:3600
# ARTIPOD_SERVE_URL overrides the proxy target
```

## Build / export

```bash
npm run export:static  # → out/ (assertions: struct-minify marker, baked version)
# from the repo root:
npm run build:ui:spa   # export + refresh; dist-ui swap happens only at U7
ARTIPOD_UI_DIR=examples/artipod-spa/out node dist/cli.js serve …
```

## Landmines (inherited, all verified real)

- `@artipod/core: file:../..` is a **COPY** (`.npmrc install-links=true`,
  load-bearing — do not remove). After any core change: root `npm run build`,
  then here `rm -rf node_modules/@artipod/core && npm install`. The export
  script does this automatically and refuses to ship a stale copy.
- Never remove `SkipStructChunkMinifyPlugin` from next.config.js; the export
  script's marker assertion is the tripwire.
- Vendor submodules (plan §2.5), when added, are consumed as `file:` deps
  against their **built dist** — npm copies them too: rebuild vendor dist →
  reinstall here → clear `.next` before concluding a fix didn't work. Never
  point bundler aliases into vendor source trees.
