/**
 * `git` as a just-bash custom command.
 *
 * Runs TRUSTED, in-page, delegating to lib/git.ts (isomorphic-git). Its
 * network goes through the CORS proxy — deliberately outside just-bash's
 * network firewall (see plan §5 Security Notes). Keep arguments validated.
 */
import { defineCommand } from 'just-bash/browser';
import { gitOps } from '../git';

const ok = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const err = (stderr: string, exitCode = 1) => ({ stdout: '', stderr, exitCode });

function renderStatus(statuses: { filepath: string; status: string }[]): string {
  if (statuses.length === 0) return 'nothing to commit, working tree clean\n';
  return statuses.map((s) => `${s.status.padEnd(12)} ${s.filepath}`).join('\n') + '\n';
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

export const makeGitCommand = () =>
  defineCommand('git', async (args, ctx) => {
    const [sub, ...rest] = args;
    try {
      switch (sub) {
        case 'clone':
          await gitOps.clone(assertHttpsUrl(rest[0]), ctx.cwd);
          return ok('Cloned.\n');
        case 'status':
          return ok(renderStatus(await gitOps.status(ctx.cwd)));
        case 'files':
          return ok((await gitOps.listFiles(ctx.cwd)).join('\n') + '\n');
        case 'diff':
          if (!rest[0]) return err('usage: git diff <file>\n');
          return ok(await gitOps.diff(rest[0], ctx.cwd));
        case undefined:
          return err('usage: git <clone|status|diff|files> [args]\n');
        default:
          return err(`git: '${sub}' is not supported. Try: clone, status, diff, files\n`);
      }
    } catch (e) {
      return err(`git: ${(e as Error).message}\n`);
    }
  });
