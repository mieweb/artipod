# Security model: agent confinement, sudo, and admin policy

> **Status: 🔮 design** (normative). Confinement default lands with plan Phase 2 (deny-by-default stub); the approval/policy machinery lands in Phase 6.5. Encryption/key mechanics are in [encryption.md](encryption.md).

## The three principals

| Principal | Runs | Boundary |
|---|---|---|
| **Agent** (LLM via tool calls) | `bash` tool + VS Code-schema tools inside its pod's sandbox | **Real and enforceable**: the model acts only through tools we execute; just-bash is the interpreter sandbox (its threat model: untrusted script author) |
| **User** (terminal, editor, console) | same sandbox surfaces, plus login/approval ceremonies | Cryptographic (keyring/leases) + UX; *not* a process boundary — same-origin code runs at one privilege |
| **Admin** (org authority) | signs policy + delegation certs; operates home-base manager | Root of the authority chain |

The asymmetry matters: **for the agent, sudo is a genuine security boundary** — the agent cannot execute anything except through the tool layer, and the tool layer enforces confinement in-process. For humans it is a ceremony plus cryptography. Docs and UI must never blur this.

## Agent confinement (default-deny)

The agent's world is the pod prepared for it — its manifest defines every mount it can see. Confined by construction:

- `bash` executes in the pod sandbox: pod fs only, no network unless the pod config allows it, execution limits on.
- File tools resolve inside pod mounts; path escapes are rejected (existing `ArtiMount` traversal guards).
- git/OCI commands operate on the pod's own store; push targets limited to the pod's configured remotes.
- `/proc` shows the pod's own state; the keyring view exposes names/expiries, never key material.

**Everything else is a privileged operation**: mounting or reading *other* pods, host paths, devices, new network destinations, keyring mutations, docker execution, registry pushes to new destinations, deleting snapshots/history.

## `sudo` — the only escape hatch

When a command needs privilege, it does not run. Instead:

```
agent: sudo artipod mount clinical/8cb31a7d /patients/123 --readonly
         │
         ▼
manager emits approval:request {
  principal: "agent:session-42", command, capability: { verb: "mount", target: "clinical/8cb31a7d",
  mode: "ro", ttl: "10m" }, justification: <agent-supplied string>
}
         │
         ├─ admin policy check ──── denied class? ──► EPERM immediately (no prompt shown)
         ▼
UI prompt to the human (console/panel): exact capability, target, TTL, justification
         │
         ├─ user lacks approval right (policy) ──► EPERM ("approval requires role X")
         ├─ user denies ──► EPERM
         ▼ user approves
manager mints a scoped capability: keyring entry { capability, ttl } (visible in /proc/keys)
command re-executes under it · audit event appended
```

Non-negotiable properties:

1. **Agents can never self-approve**, and approvals are per-capability, scoped, and TTL'd — never "grant this agent sudo".
2. **The human's approval only counts if admin policy says so.** Approval rights are a *policy-granted role*, not a default. A user without the role sees the request but cannot approve it (or, per policy, never sees it).
3. **Deny-by-policy never prompts.** If a capability class is banned, `sudo` fails instantly — prompting for unapprovable things trains users to click.
4. **Everything is audited**: request, decision, principal chain, capability, expiry — appended to the pod's provenance stream (survives sync; itself snapshot-versioned).

## Admin policy

Policy is a signed document distributed with delegation certs (verifiable offline, same chain as [encryption.md](encryption.md#delegated-authority-the-certificate-chain)):

```json
{
  "formatVersion": 1,
  "approverRoles": { "escape-approve": ["role:clinician-lead", "role:developer"] },
  "capabilities": {
    "mount-other-pod":   { "approvable": true,  "maxTtl": "15m", "modes": ["ro"] },
    "network-new-host":  { "approvable": true,  "maxTtl": "5m" },
    "docker-exec":       { "approvable": true,  "maxTtl": "30m", "principals": ["user:*"] },
    "keyring-export":    { "approvable": false },
    "history-delete":    { "approvable": false }
  },
  "defaults": { "approvable": false },
  "sig": "…admin…"
}
```

- `defaults.approvable: false` — unknown capability classes are unapprovable until the admin says otherwise.
- Policy travels with delegation: a ship/station manager enforces the same signed policy offline; a delegated manager can *narrow* policy within its scope, never widen it.
- The same mechanism governs the human bulk-decrypt flow (`sudo artipod mount --all` from [encryption.md](encryption.md#command-surface)): that is simply a capability request whose principal is a user and whose ceremony includes re-auth (+ optional passkey tap).

## Server parity

Server-side (`/api/exec` sessions and the docker realizer) uses the identical flow: sessions are pod-confined; privileged requests surface to the operator UI / policy service; approvals mint the same scoped, TTL'd capabilities. One model, two runtimes.

## What this is not

- Not process isolation in the browser — a compromised page bypasses UX, not cryptography ([encryption.md threat table](encryption.md#threat-model-read-before-assuming-more)).
- Not a substitute for just-bash's own limits (they stay on: execution limits, no network by default, per-exec abort).
- Not automatic conflict-free multi-pod access — a sudo mount of another pod is read-only unless policy explicitly allows `rw`, and `rw` cross-pod writes create ordinary branches subject to explicit merge.
