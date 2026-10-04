/**
 * Signed admin policy (docs/security-model.md "Admin policy"): which
 * capability classes are approvable at all, TTL/mode clamps, and who may
 * approve. Unknown classes fall to `defaults` — ship `approvable: false`.
 */
import { verifyJson } from './crypto.js';

export interface CapabilityRule {
  approvable: boolean;
  maxTtlMs?: number;
  modes?: string[];
  principals?: string[];
}

export interface AdminPolicy {
  formatVersion: 1;
  /** role name → principals/roles that hold it (e.g. escape-approve). */
  approverRoles: Record<string, string[]>;
  capabilities: Record<string, CapabilityRule>;
  defaults: { approvable: boolean };
  sig?: string;
}

export const APPROVER_ROLE = 'escape-approve';

export async function verifyPolicy(policy: AdminPolicy, authorityPublicKey: string): Promise<void> {
  if (!(await verifyJson(policy, authorityPublicKey))) throw new Error('admin policy signature fails verification');
}

/** The rule for a class (falling back to defaults for unknown classes). */
export function evaluateCapability(policy: AdminPolicy, capabilityClass: string): CapabilityRule {
  return policy.capabilities[capabilityClass] ?? { approvable: policy.defaults.approvable };
}

/** Approval rights are policy-granted, never a default. */
export function canApprove(policy: AdminPolicy, approver: { principal: string; roles?: string[] }): boolean {
  const holders = policy.approverRoles[APPROVER_ROLE] ?? [];
  if (holders.includes(approver.principal)) return true;
  return (approver.roles ?? []).some((role) => holders.includes(role));
}

/**
 * A delegated manager may NARROW policy within its scope, never widen it:
 * the effective rule is the intersection (approvable only if both say so,
 * the smaller TTL, the mode/principal subsets).
 */
export function narrowPolicy(parent: AdminPolicy, child: AdminPolicy): AdminPolicy {
  const capabilities: Record<string, CapabilityRule> = {};
  const classes = new Set([...Object.keys(parent.capabilities), ...Object.keys(child.capabilities)]);
  for (const cls of classes) {
    const p = evaluateCapability(parent, cls);
    const c = evaluateCapability(child, cls);
    capabilities[cls] = {
      approvable: p.approvable && c.approvable,
      ...(p.maxTtlMs ?? c.maxTtlMs ? { maxTtlMs: Math.min(p.maxTtlMs ?? Infinity, c.maxTtlMs ?? Infinity) } : {}),
      ...(p.modes || c.modes ? { modes: (p.modes ?? c.modes ?? []).filter((m) => (c.modes ?? p.modes ?? []).includes(m)) } : {}),
    };
  }
  return {
    formatVersion: 1,
    approverRoles: child.approverRoles,
    capabilities,
    defaults: { approvable: parent.defaults.approvable && child.defaults.approvable },
  };
}
