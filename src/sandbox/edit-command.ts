/**
 * `edit` as a just-bash custom command: resolves the argument against the
 * shell cwd and hands the path to the host (Monaco in the browser).
 */
import { defineCommand } from 'just-bash/browser';

export const makeEditCommand = (onEdit?: (path: string) => void) =>
  defineCommand('edit', async (args, ctx) => {
    if (!args[0]) {
      return { stdout: '', stderr: 'usage: edit <file>\n', exitCode: 1 };
    }
    if (!onEdit) {
      return { stdout: '', stderr: 'edit: no editor attached in this environment\n', exitCode: 1 };
    }
    const path = ctx.fs.resolvePath(ctx.cwd, args[0]);
    onEdit(path);
    return { stdout: `Opening editor for ${path}...\n`, stderr: '', exitCode: 0 };
  });
