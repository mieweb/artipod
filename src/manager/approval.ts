/**
 * The sudo approval flow (docs/security-model.md — normative). The broker
 * enforces the four non-negotiables: agents never self-approve; approval
 * rights are policy-granted; deny-by-policy never prompts; everything is
 * audited to the pod provenance stream.
 */
import type { PodEvents } from '../events.js';
import type { Keyring } from './keyring.js';
import type { AuditLog } from './audit.js';
import { canApprove, evaluateCapability, type AdminPolicy } from './policy.js';

export interface CapabilityRequest {
  /** Policy class, e.g. `mount-other-pod`, `docker-exec`. */
  class: string;
  verb: string;
  target?: string;
  mode?: string;
  ttlMs?: number;
}

export interface ApprovalPromptResult {
  approved: boolean;
  approver: { principal: string; roles?: string[] };
}

export type ApprovalPrompt = (request: {
  principal: string;
  command: string;
  capability: CapabilityRequest;
  justification?: string;
}) => Promise<ApprovalPromptResult>;

export type ApprovalOutcome =
  | { ok: true; capabilityName: string; expiresAt: number }
  | { ok: false; code: 'EPERM'; reason: string };

export interface ApprovalBrokerOptions {
  policy: AdminPolicy;
  keyring: Keyring;
  events?: PodEvents;
  audit?: AuditLog;
  /** The human. Absent = nobody to ask = every approvable request denies. */
  prompt?: ApprovalPrompt;
  clock?: () => number;
}

export const capabilityName = (c: CapabilityRequest): string =>
  `cap:${c.class}:${c.target ?? '*'}${c.mode ? `:${c.mode}` : ''}`;

export class ApprovalBroker {
  private readonly clock: () => number;

  constructor(private readonly options: ApprovalBrokerOptions) {
    this.clock = options.clock ?? Date.now;
  }

  /** A live minted capability for this request, if one exists. */
  holds(capability: CapabilityRequest): boolean {
    return this.options.keyring.getCapability(capabilityName(capability)) !== null;
  }

  async request(input: {
    principal: string;
    command: string;
    capability: CapabilityRequest;
    justification?: string;
  }): Promise<ApprovalOutcome> {
    const { policy, keyring, events, audit, prompt } = this.options;
    const { capability } = input;
    const at = new Date(this.clock()).toISOString();
    const auditBase = {
      at,
      principal: input.principal,
      capability: { class: capability.class, verb: capability.verb, target: capability.target, mode: capability.mode, ttlMs: capability.ttlMs },
    };

    const rule = evaluateCapability(policy, capability.class);
    // Non-negotiable #3: deny-by-policy never prompts.
    if (!rule.approvable) {
      await audit?.append({ ...auditBase, kind: 'approval:unapprovable', reason: `capability class '${capability.class}' is not approvable by policy` });
      return { ok: false, code: 'EPERM', reason: `capability class '${capability.class}' is banned by policy` };
    }
    if (rule.modes && capability.mode && !rule.modes.includes(capability.mode)) {
      await audit?.append({ ...auditBase, kind: 'approval:unapprovable', reason: `mode '${capability.mode}' not allowed for '${capability.class}'` });
      return { ok: false, code: 'EPERM', reason: `mode '${capability.mode}' is not allowed for '${capability.class}'` };
    }

    events?.emit('approval:request', {
      verb: capability.verb,
      target: capability.target,
      justification: input.justification,
      principal: input.principal,
      capability: { class: capability.class, mode: capability.mode, ttlMs: capability.ttlMs },
      command: input.command,
    });
    await audit?.append({ ...auditBase, kind: 'approval:request', reason: input.justification });

    if (!prompt) {
      await audit?.append({ ...auditBase, kind: 'approval:denied', reason: 'no approver channel configured' });
      return { ok: false, code: 'EPERM', reason: 'no approver available' };
    }
    const result = await prompt({ principal: input.principal, command: input.command, capability, justification: input.justification });

    // Non-negotiable #2: the human's approval only counts if policy says so.
    if (!canApprove(policy, result.approver)) {
      await audit?.append({ ...auditBase, kind: 'approval:denied', approver: result.approver.principal, reason: 'approver lacks the escape-approve role' });
      return { ok: false, code: 'EPERM', reason: `approval requires the escape-approve role ('${result.approver.principal}' does not hold it)` };
    }
    if (!result.approved) {
      await audit?.append({ ...auditBase, kind: 'approval:denied', approver: result.approver.principal, reason: 'denied by approver' });
      return { ok: false, code: 'EPERM', reason: 'denied by approver' };
    }

    const ttlMs = Math.min(capability.ttlMs ?? rule.maxTtlMs ?? 5 * 60_000, rule.maxTtlMs ?? Infinity);
    const expiresAt = this.clock() + ttlMs;
    const name = capabilityName(capability);
    keyring.put({
      name,
      kind: 'capability',
      expiresAt,
      meta: {
        principal: input.principal,
        approver: result.approver.principal,
        verb: capability.verb,
        ...(capability.target ? { target: capability.target } : {}),
        ...(capability.mode ? { mode: capability.mode } : {}),
      },
    });
    await audit?.append({ ...auditBase, kind: 'approval:approved', approver: result.approver.principal, details: { capabilityName: name, expiresAt: new Date(expiresAt).toISOString() } });
    return { ok: true, capabilityName: name, expiresAt };
  }
}

/** Default mapping from a sudo'd command line to a policy capability class. */
export function classifyCommand(args: string[]): CapabilityRequest {
  const [first, second] = args;
  if (first === 'artipod' && second === 'mount') {
    return {
      class: 'mount-other-pod',
      verb: 'mount',
      target: args[2],
      mode: args.includes('--readonly') || args.includes('--ro') ? 'ro' : 'rw',
      ttlMs: 10 * 60_000,
    };
  }
  if (first === 'docker') return { class: 'docker-exec', verb: 'docker', target: args.slice(1).join(' ') || undefined, ttlMs: 30 * 60_000 };
  if (first === 'artipod' && (second === 'gc' || second === 'compact')) {
    return { class: 'history-delete', verb: second, target: args.slice(2).join(' ') || undefined };
  }
  return { class: first ?? 'unknown', verb: first ?? 'unknown', target: args.slice(1).join(' ') || undefined };
}
