/**
 * `uname` and `hostname` — which shell am I in? The catalog console, a pod
 * workspace and a server exec session all run the same bash; the identity
 * the host supplied is the only thing that tells them apart.
 */
import { defineCommand } from 'just-bash/browser';
import type { ExecResult } from 'just-bash/browser';
import { withCompletion } from './types.js';
import { describeIdentity, hostnameOf, type SandboxIdentity } from '../proc/identity.js';

export { describeIdentity };

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 });

const USAGE = `usage: uname [-a] [-s] [-n] [-r] [-o] [-m]

  -s  kernel name         artipod
  -n  nodename            this shell's hostname (catalog, or the workspace slug)
  -r  release             the artipod version
  -o  operating system    what this shell is a shell of: catalog console, a pod
                          workspace (with its mode), or a server exec session
  -m  machine             the runtime: browser / node
  -a  all of the above
`;

const machine = (): string => (typeof window !== 'undefined' && typeof document !== 'undefined' ? 'browser' : 'node');

export function makeUnameCommands(identity: SandboxIdentity) {
  const uname = withCompletion(defineCommand('uname', async (args) => {
    if (args.includes('--help')) return ok(USAGE);
    const flags = new Set(args.flatMap((a) => (a.startsWith('-') && !a.startsWith('--') ? a.slice(1).split('') : [])));
    const all = flags.has('a');
    const parts: string[] = [];
    if (all || flags.has('s') || flags.size === 0) parts.push('artipod');
    if (all || flags.has('n')) parts.push(hostnameOf(identity));
    if (all || flags.has('r')) parts.push(identity.version ?? 'unknown');
    if (all || flags.has('o')) parts.push(describeIdentity(identity));
    if (all || flags.has('m')) parts.push(machine());
    return ok(`${parts.join(' ')}\n`);
  }), () => ['-a', '-s', '-n', '-r', '-o', '-m']);
  const hostname = defineCommand('hostname', async () => ok(`${hostnameOf(identity)}\n`));
  return [uname, hostname];
}
