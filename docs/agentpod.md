# AgentPod layout ✅ (contract) · 🔮 (harness, delegation)

> Status: the file layout and the `@artipod/core/agent` reader/writer below are shipped and stable — editors and harnesses may target them. Running an AgentPod (harness-core), capability grants and the `artipod ps` delegation table are design (see [../plan/spa-ui-plan.md](../plan/spa-ui-plan.md) P11).

An **AgentPod** is an artipod whose artifacts *are* the agent. Versioning, sealing, forking, encryption and provenance-by-digest are inherited from the pod; nothing about the agent lives outside it except what must: **secrets and MCP endpoints are the user's**, never in the pod or the model context. The pod names the capabilities it wants; the host decides what to grant.

## Layout

```
<root>/
  AGENT.md                 instructions (Markdown) + YAML front matter
  skills/
    <name>/SKILL.md        one skill per directory; the directory name is the skill's identity
  tools/
    <file>.json            an McpToolDescriptor, or an array of them
```

`<root>` is any directory in the pod (commonly `/`). A directory without `AGENT.md` is not an AgentPod (`readAgentPod` returns `null`). Skill directories without `SKILL.md` are skipped; non-`.json` files under `tools/` are ignored; a malformed tool file throws with its path.

### `AGENT.md` front matter

| Key | Type | Meaning |
|---|---|---|
| `name` | string | Display name |
| `description` | string | One-liner for catalogs |
| `needs` | string[] | Capability names the agent requests (`chart.read`, `orders.write`, …). The dialect of names belongs to ozwellai-api; artipod treats them as opaque strings the host maps to grants. |
| `model` | string | Preferred model id — advisory, the venue decides |

Unknown keys round-trip untouched. `SKILL.md` uses the same keys (`name`, `description`, `needs`). The front-matter dialect is the **YAML subset of scalars and flat lists** (block `- item` or inline `[a, b]`); nested maps are not part of the contract.

```md
---
name: triage
description: Triage nurse
needs:
  - chart.read
  - vitals.write
model: ozwell-1
---
# Triage

Be brief. Record vitals before anything else.
```

### `tools/*.json`

Each file holds one [`McpToolDescriptor`](../src/agent/types.ts) (`name`, `description`, `inputSchema: { type: 'object', properties, required? }`) or an array of them. Descriptors *describe* tools; the implementation is bound by the host at run time (sandbox tools via `createSandboxTools`, or client tools over the MCP transport).

## API (`@artipod/core/agent`)

```ts
import { readAgentPod, writeAgentPod, parseFrontmatter, serializeFrontmatter, AGENT_POD_LAYOUT } from '@artipod/core/agent';

const agent = await readAgentPod(pod.zfs, '/');          // AgentPod | null
agent.agent.frontmatter.needs;                            // string[] | undefined
agent.skills[0].instructions;                             // SKILL.md body
agent.tools.flatMap((t) => t.descriptors);                // McpToolDescriptor[]

await writeAgentPod(pod.zfs, '/', agent, { prune: true }); // prune = remove skills/tools not in `agent`
```

`readAgentPod`/`writeAgentPod` accept a node-style `fs` (`zfs`) or its `promises` object. Writes go through the pod's fs, so they land in the overlay, push with the workspace and appear in `fs:changed` like any editor save.

## Not in the pod

- **Secrets, tokens, MCP endpoints** — the user's; delegated to a running agent as a temporary, revocable grant (the [lease shape](encryption.md) pointed at tool grants: TTL, release-now, renewal visible). 🔮
- **Runtime state** (conversation, tool results) — belongs to the session, not the definition. Snapshots of the pod capture the agent *as defined*, not *as run*.
