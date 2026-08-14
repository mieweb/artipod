/**
 * `lsmod`, `modinfo`, `modprobe` — the proc providers presented as kernel
 * modules, because that is exactly what they are: named, versioned projections
 * that can be loaded and unloaded while the shell runs.
 *
 * Registry-scoped: `modprobe` toggles an already-registered provider, it does
 * not fetch code.
 */
import { defineCommand } from 'just-bash/browser';
import type { ExecResult } from 'just-bash/browser';
import { listProviders, getProvider, setProviderEnabled } from '../proc/registry';
import { procEntries, procPathOf } from '../proc/snapshot';
import { renderTable } from './table';

const USAGE: Record<string, string> = {
  lsmod: `usage: lsmod

List the registered /proc providers: name, mode, file count and load state.
`,
  modinfo: `usage: modinfo <name>

Print a provider's description, version, mode and the files it projects.
`,
  modprobe: `usage: modprobe [-r] <name>

Load (-r: unload) a /proc provider. An unloaded provider's files disappear
from /proc at the next refresh; the provider itself stays registered.
`,
};

const help = (name: string, args: string[]): ExecResult | null =>
  args.includes('--help') || args.includes('-h')
    ? { stdout: USAGE[name], stderr: '', exitCode: 0 }
    : null;

const err = (message: string): ExecResult => ({ stdout: '', stderr: `${message}\n`, exitCode: 1 });

/** Files the last snapshot refresh wrote for a provider. */
function filesOf(name: string): string[] {
  const paths: string[] = [];
  for (const [path, entry] of procEntries()) {
    if (entry.provider.name === name) paths.push(path);
  }
  return paths.sort();
}

const makeLsmodCommand = () =>
  defineCommand('lsmod', async (args) => {
    const h = help('lsmod', args);
    if (h) return h;
    const rows = listProviders().map(({ provider, enabled }) => [
      provider.name,
      provider.mode,
      String(filesOf(provider.name).length),
      enabled ? 'Live' : 'Unloaded',
    ]);
    return {
      stdout: renderTable(['Module', 'Mode', 'Files', 'State'], rows, [2]),
      stderr: '',
      exitCode: 0,
    };
  });

const makeModinfoCommand = () =>
  defineCommand('modinfo', async (args) => {
    const h = help('modinfo', args);
    if (h) return h;
    const name = args[0];
    if (!name) return err("modinfo: missing module name (try 'modinfo --help')");
    const module = getProvider(name);
    if (!module) return err(`modinfo: ERROR: Module ${name} not found.`);

    const { provider, enabled } = module;
    const files = filesOf(name);
    const lines = [
      `name:        ${provider.name}`,
      `description: ${provider.description ?? '-'}`,
      `version:     ${provider.version ?? '-'}`,
      `mode:        ${provider.mode}`,
      `state:       ${enabled ? 'Live' : 'Unloaded'}`,
      `root:        ${procPathOf(provider, '').replace(/\/$/, '') || '/proc'}`,
      ...files.map((path) => `file:        ${path}`),
    ];
    return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
  });

const makeModprobeCommand = () =>
  defineCommand('modprobe', async (args) => {
    const h = help('modprobe', args);
    if (h) return h;
    const remove = args.includes('-r') || args.includes('--remove');
    const name = args.find((a) => !a.startsWith('-'));
    if (!name) return err("modprobe: missing module name (try 'modprobe --help')");
    if (!setProviderEnabled(name, !remove)) {
      return err(`modprobe: FATAL: Module ${name} not found.`);
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

export const makeModuleCommands = () => [
  makeLsmodCommand(),
  makeModinfoCommand(),
  makeModprobeCommand(),
];
