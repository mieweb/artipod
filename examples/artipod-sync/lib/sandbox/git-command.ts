/**
 * `git` as a just-bash custom command.
 *
 * Runs TRUSTED, in-page, delegating to lib/git.ts (isomorphic-git). Its
 * network goes through the CORS proxy — deliberately outside just-bash's
 * network firewall (see plan §5 Security Notes). Keep arguments validated.
 */
import { defineCommand } from 'just-bash/browser';
import type { GitOps, GitStatusResult } from '../git';
import { getAuthor, setAuthor } from '../git';
import { persistenceEnabled, setPersistence } from '../git-auth';

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const err = (stderr: string, exitCode = 1) => ({ stdout: '', stderr, exitCode });

const USAGE =
  'usage: git <clone|status|add|reset|rm|commit|log|branch|checkout|fetch|pull|push|diff|files|config> [args]\n';

function renderStatus({ branch, changes }: GitStatusResult): string {
  const head = `On branch ${branch ?? '(detached)'}\n`;
  if (changes.length === 0) return head + 'nothing to commit, working tree clean\n';
  return head + changes.map((c) => `${c.code} ${c.filepath}`).join('\n') + '\n';
}

function renderLog(
  commits: { oid: string; message: string; author: string; email: string; timestamp: number }[],
  oneline: boolean,
): string {
  if (oneline) {
    return commits.map((c) => `${c.oid.slice(0, 7)} ${c.message.split('\n')[0]}`).join('\n') + '\n';
  }
  return commits
    .map((c) => {
      const date = new Date(c.timestamp * 1000).toISOString();
      return `commit ${c.oid}\nAuthor: ${c.author} <${c.email}>\nDate:   ${date}\n\n    ${c.message.trim().replace(/\n/g, '\n    ')}\n`;
    })
    .join('\n');
}

/** Only https:// git URLs are permitted (host-hook escape hatch stays narrow). */
function assertHttpsUrl(url: string | undefined): string {
  if (!url) throw new Error('missing repository URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`only https:// repository URLs are supported (got ${parsed.protocol}//)`);
  }
  return url;
}

function parseFlags(args: string[], flagsWithValue: string[] = []): { flags: Map<string, string>; positional: string[] } {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (flagsWithValue.includes(a)) {
        flags.set(a, args[++i] ?? '');
      } else {
        flags.set(a, '');
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function handleConfig(rest: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [key, ...valueParts] = rest;
  const value = valueParts.join(' ');
  switch (key) {
    case 'user.name':
      if (!value) return ok(getAuthor().name + '\n');
      setAuthor({ name: value });
      return ok('');
    case 'user.email':
      if (!value) return ok(getAuthor().email + '\n');
      setAuthor({ email: value });
      return ok('');
    case 'credential.persist':
      if (!value) return ok(String(persistenceEnabled()) + '\n');
      setPersistence(value === 'true');
      return ok('');
    default:
      return err(`git config: supported keys: user.name, user.email, credential.persist\n`);
  }
}

export const makeGitCommand = (gitOps: GitOps) =>
  defineCommand('git', async (args, ctx) => {
    const [sub, ...rest] = args;
    const dir = ctx.cwd;
    try {
      switch (sub) {
        case 'clone':
          await gitOps.clone(assertHttpsUrl(rest[0]), dir);
          return ok('Cloned.\n');
        case 'status':
          return ok(renderStatus(await gitOps.status(dir)));
        case 'files':
          return ok((await gitOps.listFiles(dir)).join('\n') + '\n');
        case 'diff': {
          const { flags, positional } = parseFlags(rest);
          if (flags.has('--staged') || flags.has('--cached')) {
            return ok(await gitOps.diffStaged(dir));
          }
          if (positional[0]) return ok(await gitOps.diff(positional[0], dir));
          return ok(await gitOps.diffAll(dir));
        }
        case 'add': {
          if (!rest[0]) return err('usage: git add <path>|.\n');
          const staged = await gitOps.add(rest[0], dir);
          return ok(staged.length ? '' : 'nothing to add\n');
        }
        case 'reset':
          if (!rest[0]) return err('usage: git reset <path>\n');
          await gitOps.reset(rest[0], dir);
          return ok('');
        case 'rm':
          if (!rest[0]) return err('usage: git rm <path>\n');
          await gitOps.rm(rest[0], dir);
          return ok('');
        case 'commit': {
          const { flags } = parseFlags(rest, ['-m']);
          const message = flags.get('-m');
          if (!message) return err('usage: git commit -m "message"\n');
          const oid = await gitOps.commit(message, dir);
          return ok(`[${oid.slice(0, 7)}] ${message}\n`);
        }
        case 'log': {
          const { flags } = parseFlags(rest, ['-n']);
          const depth = flags.has('-n') ? parseInt(flags.get('-n') ?? '', 10) || 10 : undefined;
          const commits = await gitOps.log(dir, { depth });
          return ok(renderLog(commits, flags.has('--oneline')));
        }
        case 'branch': {
          const { flags } = parseFlags(rest);
          const { current, branches } = await gitOps.branch(dir, { all: flags.has('-a') });
          return ok(branches.map((b) => (b === current ? `* ${b}` : `  ${b}`)).join('\n') + '\n');
        }
        case 'checkout': {
          const { flags, positional } = parseFlags(rest, ['-b']);
          const create = flags.get('-b');
          const ref = create || positional[0];
          if (!ref) return err('usage: git checkout <ref> | git checkout -b <name>\n');
          await gitOps.checkout(ref, dir, { create: Boolean(create) });
          return ok(`Switched to ${create ? 'a new branch ' : ''}'${ref}'\n`);
        }
        case 'fetch':
          await gitOps.fetch(dir);
          return ok('Fetched.\n');
        case 'pull':
          await gitOps.pull(dir);
          return ok('Already up to date or fast-forwarded.\n');
        case 'push':
          return ok((await gitOps.push(dir)) + '\n');
        case 'config':
          return handleConfig(rest);
        case undefined:
          return err(USAGE);
        default:
          return err(`git: '${sub}' is not supported.\n${USAGE}`);
      }
    } catch (e) {
      return err(`git: ${(e as Error).message}\n`);
    }
  });
