/**
 * `sudo` — the only escape hatch from the pod (docs/security-model.md is
 * normative). Without a broker this stays the Phase 2 default-deny stub;
 * with one, requests flow through admin policy + human approval, mint
 * scoped TTL capabilities in the keyring, and re-execute when the host
 * wires an executor. Agents can never self-approve either way.
 */
import { defineCommand } from 'just-bash/browser';
import type { PodEvents } from '../events.js';
import { classifyCommand, type ApprovalBroker } from '../manager/approval.js';

export const SUDO_DENIED_MESSAGE =
  'sudo: EPERM: privileged execution requires human approval — no approval broker is configured for this pod (docs/security-model.md)\n';

export interface SudoOptions {
  broker?: ApprovalBroker;
  /** Requesting principal, e.g. `agent:session-42`. */
  principal?: string;
  /** Re-execute the approved command (host-supplied, minus `sudo`). */
  execute?: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export const makeSudoCommand = (events?: PodEvents, options: SudoOptions = {}) =>
  defineCommand('sudo', async (args) => {
    let justification: string | undefined;
    if (args[0] === '--justify' || args[0] === '-J') {
      justification = args[1];
      args = args.slice(2);
    }
    const command = args.join(' ');

    if (!options.broker) {
      events?.emit('approval:request', {
        verb: 'sudo',
        target: command || undefined,
        justification: justification ?? 'default-deny: no approval broker configured',
      });
      return { stdout: '', stderr: SUDO_DENIED_MESSAGE, exitCode: 1 };
    }

    const capability = classifyCommand(args);
    const principal = options.principal ?? 'agent:unknown';

    const run = async () => {
      if (!options.execute) {
        return { stdout: `sudo: capability granted for '${command}' (no executor wired — re-run inside its TTL)\n`, stderr: '', exitCode: 0 };
      }
      return options.execute(command);
    };

    // A live capability from an earlier approval covers re-execution.
    if (options.broker.holds(capability)) return run();

    const outcome = await options.broker.request({ principal, command, capability, justification });
    if (!outcome.ok) return { stdout: '', stderr: `sudo: EPERM: ${outcome.reason}\n`, exitCode: 1 };
    return run();
  });
