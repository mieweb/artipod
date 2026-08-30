# The Ctrl+~ console module

> **Status: 🔮 design.** Depends on `/host` controllers and `pod.events` (plan Phase 2); packaged as `@artipod/core/console`. Lock/login UX depends on Phase 6.5.

A drop-in, hotkey-summoned overlay terminal — the Quake console for web apps. Any application that hosts a pod gets a full artipod shell without building terminal UI.

```ts
import { installConsole } from '@artipod/core/console';

const console = installConsole({
  pod,                       // or getPod: () => Promise<Pod> for lazy init
  hotkey: 'Ctrl+`',          // default; Ctrl+~ is the same physical key — both bindings registered
  position: 'top',           // 'top' | 'bottom' drawer
  renderer: 'builtin',       // 'builtin' (zero-dep DOM renderer) | 'xterm' (optional peer)
});
console.uninstall();         // removes hotkey + DOM, disposes the session
```

Script-tag variant for non-bundled sites (IIFE build): attaches to (or creates) the origin's default pod.

## What it is

- A packaged consumer of the same `/host` controllers every app uses: `TerminalSession` for line discipline/history/completion/abort, `pod.events` for coherence. No console-only code paths — if it works in the console, it works in the app's own terminal.
- **A human surface, not an agent one.** The console runs under the *user's* keyring/leases. `sudo` from the console follows the human ceremony (re-auth ± passkey) in [security-model.md](security-model.md); `approval:request` events from agents also surface here as prompts — the console doubles as the approval UI when the host app hasn't built one.
- Lock-aware: a locked pod renders a login prompt instead of a shell; lease expiry mid-session drops to the lock screen with state preserved ([encryption.md](encryption.md#the-keyring-and-leases)).

## Behavior details

- **Hotkey**: default `` Ctrl+` `` (registering the shifted `Ctrl+~` too); configurable; ignores keystrokes inside editable elements unless `force: true`; Esc collapses.
- **Overlay discipline**: fixed-position drawer, max z-index tier, focus-trapped while open, focus returned on collapse; `prefers-reduced-motion` respected (no slide animation).
- **Renderer**: `builtin` is a small monospace DOM renderer (ANSI color subset, links) to keep the module dependency-free; `xterm` upgrade path uses the host app's xterm as an optional peer — never bundled.
- **SSR-safe**: `installConsole` is a no-op until DOM exists; module import is side-effect-free and Node-safe (tests import it).
- **Multi-tab**: honors `isPrimaryTab` — secondary tabs get a read-only console with a banner.
- **Isolation caveat**: the overlay lives in the host page's origin; it inherits the page's CSP and trust. It is a *convenience surface* over the pod, not a security boundary — the boundaries are the keyring and the sudo policy.

## Why it exists

1. Every mieweb app embedding AI components gets an inspectable workspace: pop the console, `ls`, `git diff`, `artipod snapshot diff` — see exactly what an agent did.
2. Support/debug: a support engineer (with the right approvals) can `sudo artipod ls` on a user's machine and inspect pod state without installing anything.
3. Demos: the north-star demo runs entirely from the console of an otherwise ordinary page.
