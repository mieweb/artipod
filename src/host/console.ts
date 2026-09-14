/**
 * openConsole() — a shell without a pod (Decision D18): the catalog console
 * over the raw browser filesystem, a server exec session over its chroot.
 * It owns a process namespace (pid 1 = the console, the shell is pid 2) and
 * wires the pod-less `artipod` verb, so `ps`, `uname -a`, `images`/`volumes`
 * behave exactly as they do inside a pod. A pod's shells come from
 * `pod.createSandbox()` instead — the pod owns that namespace.
 */
import { createSandbox, type CreateSandboxOptions } from '../sandbox/index.js';
import { makeConsoleArtipodCommand } from '../sandbox/inventory-command.js';
import type { Sandbox, SandboxIdentity } from '../sandbox/types.js';
import { openNamespace } from '../proc/namespace.js';
import type { ProcessTable } from '../proc/processes.js';

export interface ConsoleOptions extends Omit<CreateSandboxOptions, 'processes' | 'identity'> {
  /** Required here: a console with no name cannot say what it is. */
  identity: SandboxIdentity;
}

export interface Console {
  readonly sandbox: Sandbox;
  readonly processes: ProcessTable;
  /** Retires the shell, unprojects `/proc`, cascades KILL through the namespace. */
  dispose(): Promise<void>;
}

export function openConsole(opts: ConsoleOptions): Console {
  // No /proc in the shell (the default here) means nothing global is touched.
  const namespace = openNamespace({ name: opts.identity.name, inventory: opts.inventory, proc: opts.proc === true });
  const sandbox = createSandbox({
    ...opts,
    processes: namespace.processes,
    extraCommands: [makeConsoleArtipodCommand(opts.inventory ?? {}, namespace.processes), ...(opts.extraCommands ?? [])],
  });
  return {
    sandbox,
    processes: namespace.processes,
    dispose() {
      sandbox.dispose();
      return namespace.dispose();
    },
  };
}
