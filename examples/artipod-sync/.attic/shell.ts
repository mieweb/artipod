import { fs } from './filesystem';
import { gitOps } from './git';

export class Shell {
  private cwd: string = '/repo';
  private onEdit: (path: string) => void;

  constructor(onEdit: (path: string) => void) {
    this.onEdit = onEdit;
  }

  async execute(commandLine: string): Promise<string> {
    const args = commandLine.trim().split(/\s+/);
    const cmd = args[0];
    const params = args.slice(1);

    if (!cmd) return '';

    try {
      switch (cmd) {
        case 'ls':
          return await this.ls(params);
        case 'cd':
          return await this.cd(params);
        case 'pwd':
          return this.cwd;
        case 'cat':
          return await this.cat(params);
        case 'git':
          return await this.git(params);
        case 'edit':
          return this.edit(params);
        case 'help':
          return this.help();
        default:
          return `Command not found: ${cmd}`;
      }
    } catch (error: any) {
      return `Error: ${error.message}`;
    }
  }

  private resolvePath(p: string): string {
    if (p.startsWith('/')) return p;
    if (p === '..') {
      const parts = this.cwd.split('/').filter(Boolean);
      parts.pop();
      return '/' + parts.join('/');
    }
    if (p === '.') return this.cwd;
    
    // Simple join
    const base = this.cwd === '/' ? '' : this.cwd;
    return `${base}/${p}`;
  }

  private async ls(args: string[]): Promise<string> {
    const target = args[0] ? this.resolvePath(args[0]) : this.cwd;
    try {
      const files = await fs.promises.readdir(target);
      return files.join('  ');
    } catch (e) {
      throw new Error(`Cannot list directory ${target}`);
    }
  }

  private async cd(args: string[]): Promise<string> {
    if (!args[0]) return '';
    const target = this.resolvePath(args[0]);
    try {
      const stat = await fs.promises.stat(target);
      if (!stat.isDirectory()) {
        return `${args[0]}: Not a directory`;
      }
      this.cwd = target;
      return '';
    } catch (e) {
      return `cd: ${args[0]}: No such file or directory`;
    }
  }

  private async cat(args: string[]): Promise<string> {
    if (!args[0]) return 'Usage: cat <file>';
    const target = this.resolvePath(args[0]);
    try {
      const content = await fs.promises.readFile(target, 'utf8');
      return content as string;
    } catch (e) {
      return `cat: ${args[0]}: No such file or directory`;
    }
  }

  private edit(args: string[]): string {
    if (!args[0]) return 'Usage: edit <file>';
    const target = this.resolvePath(args[0]);
    this.onEdit(target);
    return `Opening editor for ${target}...`;
  }

  private async git(args: string[]): Promise<string> {
    const subCmd = args[0];
    const gitArgs = args.slice(1);

    switch (subCmd) {
      case 'clone':
        if (!gitArgs[0]) return 'Usage: git clone <url>';
        await gitOps.clone(gitArgs[0], this.cwd);
        return 'Cloned successfully.';
      case 'status':
        const statuses = await gitOps.status(this.cwd);
        if (statuses.length === 0) return 'On branch master\nNothing to commit, working tree clean';
        return statuses.map(s => `${s.status.padEnd(12)} ${s.filepath}`).join('\n');
      case 'files':
        const files = await gitOps.listFiles(this.cwd);
        return files.join('\n');
      case 'diff':
        if (!gitArgs[0]) return 'Usage: git diff <file>';
        return await gitOps.diff(gitArgs[0], this.cwd);
      default:
        return `git: '${subCmd}' is not a git command. See 'help'.`;
    }
  }

  private help(): string {
    return `
Available commands:
  ls [dir]        List directory contents
  cd <dir>        Change directory
  pwd             Print working directory
  cat <file>      Print file content
  edit <file>     Open file in editor
  git clone <url> Clone a repository
  git status      Show working tree status
  git diff <file> Show changes in a file
  git files       List tracked files
  help            Show this help message
`;
  }
}
