/**
 * `ps` and `kill` — the process table as a shell sees it.
 *
 * The table is the pod session's PID namespace (see ../proc/processes.ts):
 * the shell itself, admitted browser apps and background tasks. Signals are
 * cooperative and per-kind; a row that does not handle one says so.
 */
import { defineCommand } from 'just-bash/browser';
import type { ExecResult } from 'just-bash/browser';
import { PROCESS_SIGNALS, ProcessError, type ProcessSignal, type ProcessTable } from '../proc/processes.js';
import { renderTable } from './table.js';
import { withCompletion } from './types.js';

const USAGE = {
  ps: `usage: ps [-l] [--json]

List the processes in this pod session: the supervisor (pid 1), shells,
running applications and background tasks. -l adds kind-specific detail;
--json emits JSON Lines, one ProcessInfo per line.
`,
  kill: `usage: kill [-STOP|-CONT|-TERM|-KILL] <pid>...

Send a signal (default TERM). STOP/CONT suspend and resume a cooperating
application in place; TERM/KILL close it. A process that does not handle
the signal reports 'Operation not supported' — nothing is faked.
`,
};

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): ExecResult => ({ stdout: '', stderr, exitCode });

const age = (startedAt: number, now: number): string => {
  const s = Math.max(0, Math.round((now - startedAt) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
};

export function makeProcessCommands(table: ProcessTable) {
  const ps = withCompletion(defineCommand('ps', async (args) => {
    if (args.includes('--help') || args.includes('-h')) return ok(USAGE.ps);
    if (args.includes('--json')) return ok(table.list().map((p) => JSON.stringify(p)).join('\n') + '\n');
    const long = args.includes('-l');
    const now = Date.now();
    const rows = table.list().map((p) => {
      const name = p.kind === 'task' ? `[${p.name}]` : p.name;
      const base = [String(p.pid), String(p.ppid), p.kind, p.state, age(p.startedAt, now), name];
      if (!long) return base;
      const detail = Object.entries(p.detail).map(([k, v]) => `${k}=${v}`).join(' ');
      return [...base, detail || '-'];
    });
    const header = ['PID', 'PPID', 'KIND', 'STATE', 'TIME', 'NAME', ...(long ? ['DETAIL'] : [])];
    return ok(renderTable(header, rows, [0, 1]));
  }), () => ['-l', '--json']);

  const kill = withCompletion(defineCommand('kill', async (args) => {
    if (args.includes('--help') || args.includes('-h')) return ok(USAGE.kill);
    let signal: ProcessSignal = 'TERM';
    const pids: number[] = [];
    for (const arg of args) {
      if (arg.startsWith('-')) {
        const name = arg.slice(1).replace(/^SIG/, '').toUpperCase();
        if (!PROCESS_SIGNALS.includes(name as ProcessSignal)) return fail(`kill: ${arg}: invalid signal specification\n`, 2);
        signal = name as ProcessSignal;
        continue;
      }
      if (!/^\d+$/.test(arg)) return fail(`kill: ${arg}: arguments must be process ids\n`, 2);
      pids.push(Number(arg));
    }
    if (pids.length === 0) return fail(USAGE.kill, 2);
    const errors: string[] = [];
    for (const pid of pids) {
      try {
        await table.signal(pid, signal);
      } catch (e) {
        const reason = e instanceof ProcessError
          ? { ESRCH: 'No such process', ENOTSUP: 'Operation not supported', EPERM: 'Operation not permitted' }[e.code]
          : (e as Error).message;
        errors.push(`kill: (${pid}) - ${reason}`);
      }
    }
    return errors.length ? fail(`${errors.join('\n')}\n`) : ok('');
  }), (_args, token) => token.startsWith('-')
    ? PROCESS_SIGNALS.map((s) => `-${s}`)
    : table.list().filter((p) => p.kind !== 'init').map((p) => String(p.pid)));

  return [ps, kill];
}
