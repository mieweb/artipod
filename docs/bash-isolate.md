# The bash isolate (browser and server)

> **Status: ✅ shipped** in artipod-sync (`lib/sandbox/`), moving to `@artipod/core/sandbox` in plan Phase 2. Facts below are source-verified against just-bash and pinned by tests — keep the tests when moving.

The isolate is [just-bash](https://github.com/vercel-labs/just-bash) — a real bash interpreter in TypeScript (pipes, redirects, globs, vars, loops, ~90 coreutils) over a pluggable `IFileSystem` — bound to the pod's ZenFS graph through our adapter. It is the *same interpreter* in the browser, in Node server sessions, and under agents.

## Architecture

```
createSandbox({ zfs, … }) → Sandbox { exec(), complete(), getCwd(), getEnv(), fs }
   ├─ ZenFsAdapter  — full IFileSystem contract over ZenFS (async-only; node-shaped errors pass through)
   ├─ custom commands (trusted, host-side): git, edit, notes, mount/umount, lsmod/modinfo/modprobe, artipod 🔮
   └─ /proc lifecycle: refresh before each exec, reconcile rw providers after
```

## Session semantics (the part everyone trips on)

just-bash `exec()` **isolates state per call by design** — "like starting a new shell"; upstream pins this with tests, and it underpins their concurrent-exec safety. The sandbox reconstructs a session host-side:

| Carried across lines | How |
|---|---|
| cwd | `result.env.PWD` → next exec's `cwd` |
| vars / exports | full env replay (`replaceEnv`) |
| aliases | ride the env as `BASH_ALIAS_<name>` (impl detail — pinned by our test) + `shopt -s expand_aliases` prelude |
| history | mirrored into `BASH_HISTORY` so the `history` builtin works |
| **not carried** | shell functions (just-bash retains no source) — documented in `help`; host-prelude accumulation is the workaround |

Do not propose upstream changes to the isolation default — it is contract-pinned. Viable upstream asks are listed in artipod-sync's `just-bash-plan.md` §10.

## The buffered-I/O constraint

Source-verified: browser custom commands receive `ctx.stdin` as a fully-materialized `ByteString` and return **one buffered** `ExecResult`; incremental stdio exists only in the Node-only `Sandbox` class (excluded from `just-bash/browser`). Consequences:

- Unbounded pipes (`cat /dev/microphone | nc …`) cannot run inside a browser pipeline. Bridge commands start **host-side stream tasks** and return immediately (`artipod stream pipe|ls|stop`, status under `/proc/streams/`) 🔮.
- Bounded operations (e.g. `record -d 10s …`) may block their single exec; Ctrl+C aborts via the per-exec `AbortSignal`.
- Big outputs are truncated for agents (16 KiB head+tail) to protect context windows.

## Security posture

- **Trust split**: just-bash defends against untrusted *scripts* (agent output qualifies). Custom commands are **trusted host code** — the escape hatch — kept minimal and argument-validated (`git` accepts `https://` only).
- **Network split**: shell `curl` exists only if just-bash `network` is configured (default off). git/OCI traffic bypasses that firewall *by design* and is governed instead by the app's proxy allowlists.
- **Limits**: `executionLimits` (+ `hardened` profile server-side), per-exec `AbortSignal`, per-session fs byte caps; a runaway `while true` dies by limits, not by freezing the tab.
- **Agent confinement and `sudo`**: the isolate is the agent's whole world; privileged verbs go through the approval flow in [security-model.md](security-model.md).

## Server sessions ✅

`/api/exec` pattern (artipod-sync `lib/server/exec-sessions.ts`, graduating to `/manager`): per-session pods via `bindContext('/sessions/<id>')` chroot-style views over one InMemory mount — files in one session invisible to another; TTL eviction; in-flight guard (429); session cap (503); 30 s exec timeout; optional bearer auth. ZenFS/just-bash must be externalized from the webpack server bundle.

## Human shell niceties ✅

Tab completion (`sandbox.complete()` → common-prefix + candidate list), history, Ctrl+C, `notes` (semantics & limitations help), table-rendered command output. Known gaps, by upstream scope: no TTY (`read -p`, `less`, `vim`), `&` parses but there is no job control, no `ls --color`.
