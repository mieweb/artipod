# artipod docs

Design-and-status documentation for `@artipod/core`. Every doc carries a status banner; ✅ marks behavior shipped in this repo today (the browser app lives at [examples/artipod-sync](../examples/artipod-sync)), 🔮 marks design. Implementation order and progress live in [../artipod-layer-plan.md](../artipod-layer-plan.md) — these docs are the *what*, the plan is the *when/how*.

| Doc | Scope | Plan phases |
|---|---|---|
| [browser.md](browser.md) | ZenFS storage, ingest API, devices, multi-tab | 0–3, 7 |
| [linux.md](linux.md) | Node/Linux runtime, Docker hardening, stores, deployment | 0–3, 6 |
| [bash-isolate.md](bash-isolate.md) | just-bash sandbox semantics, sessions, limits, custom commands | 1–3 |
| [encryption.md](encryption.md) | Ciphertext at rest, keyring, leases, offline grants, delegation | 4, 6.5 |
| [security-model.md](security-model.md) | Agent confinement, sudo, approvals, admin policy | 2, 6.5 |
| [sync.md](sync.md) | Folder publish, lazy open, write-back, per-path merge, composing with Yjs/YORM | sync plan C–F |
| [console.md](console.md) | Ctrl+~ drop-in overlay console | post-2 |

Editing rule: when implementation diverges from a doc, fix the doc in the same PR (same rule as the plan).
