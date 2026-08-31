/**
 * Agent-confinement stub (plan Phase 2; docs/security-model.md is normative):
 * the pod boundary is the tool layer, and `sudo` is the only escape. Until
 * the Phase 6.5 approval flow lands, every sudo is default-deny EPERM —
 * agents can never self-approve. The attempt is surfaced via
 * `approval:request` so hosts can already observe it.
 */
import { defineCommand } from 'just-bash/browser';
import type { PodEvents } from '../events.js';

export const SUDO_DENIED_MESSAGE =
  'sudo: EPERM: privileged execution requires human approval — the approval flow lands in Phase 6.5 (docs/security-model.md)\n';

export const makeSudoCommand = (events?: PodEvents) =>
  defineCommand('sudo', async (args) => {
    events?.emit('approval:request', {
      verb: 'sudo',
      target: args.join(' ') || undefined,
      justification: 'phase-2 stub: default-deny, no approval flow yet',
    });
    return { stdout: '', stderr: SUDO_DENIED_MESSAGE, exitCode: 1 };
  });
