import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { fs } from './filesystem';
import { createTwoFilesPatch } from 'diff';
import { onAuthForUrl, onAuthFailureForUrl } from './git-auth';

/**
 * Git operations over a ZenFS-like fs (browser singleton by default; tests
 * and the server pass their own via createGitOps). Network goes through a
 * configurable CORS proxy — self-hostable since Phase 5.
 */

// Browser: the self-hosted /api/git route (the public cors.isomorphic-git.org
// instance stalls indefinitely). Server: none — fetch there is not CORS-bound.
const DEFAULT_CORS_PROXY =
  process.env.NEXT_PUBLIC_GIT_CORS_PROXY ||
  (typeof window === 'undefined' ? undefined : '/api/git');

let corsProxy: string | undefined = DEFAULT_CORS_PROXY;
export function setCorsProxy(url: string): void {
  corsProxy = url;
}
export function getCorsProxy(): string | undefined {
  return corsProxy;
}

// --- author configuration (localStorage in browser, memory elsewhere) -------

const AUTHOR_KEY = 'artipod-sync-git-author';
const memAuthor: { name: string; email: string } = {
  name: 'artipod-sync',
  email: 'artipod-sync@localhost',
};

export function getAuthor(): { name: string; email: string } {
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(AUTHOR_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // fall through to memory default
    }
  }
  return { ...memAuthor };
}

export function setAuthor(patch: Partial<{ name: string; email: string }>): void {
  const next = { ...getAuthor(), ...patch };
  memAuthor.name = next.name;
  memAuthor.email = next.email;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(AUTHOR_KEY, JSON.stringify(next));
  }
}

// --- status ------------------------------------------------------------------

export interface StatusEntry {
  filepath: string;
  /** Two-letter short-status code (index/workdir), '??' for untracked. */
  code: string;
}

export interface GitStatusResult {
  branch: string | null;
  changes: StatusEntry[];
}

/** [head, workdir, stage] → short-status code. */
const STATUS_CODES: Record<string, string> = {
  '020': '??',
  '022': 'A ',
  '023': 'AM',
  '003': 'AD',
  '121': ' M',
  '122': 'M ',
  '123': 'MM',
  '101': ' D',
  '100': 'D ',
  '110': 'D?',
};

type ZenFsLike = typeof fs;

/** All ops take the repo dir; fs comes from the factory's getter. */
export function createGitOps(getFs: () => ZenFsLike) {
  const common = (dir: string) => ({ fs: getFs(), dir });
  const network = (dir: string, url?: string) => ({
    ...common(dir),
    http,
    corsProxy,
    onAuth: (u: string) => onAuthForUrl(url ?? u),
    onAuthFailure: (u: string) => {
      onAuthFailureForUrl(url ?? u);
    },
  });

  async function readHeadContent(dir: string, filepath: string): Promise<string> {
    try {
      const commitOid = await git.resolveRef({ ...common(dir), ref: 'HEAD' });
      const { blob } = await git.readBlob({ ...common(dir), oid: commitOid, filepath });
      return new TextDecoder().decode(blob);
    } catch {
      return ''; // new file
    }
  }

  async function readWorkContent(dir: string, filepath: string): Promise<string> {
    try {
      return (await getFs().promises.readFile(`${dir}/${filepath}`, 'utf8')) as string;
    } catch {
      return ''; // deleted file
    }
  }

  async function diffOne(dir: string, filepath: string): Promise<string> {
    const headContent = await readHeadContent(dir, filepath);
    const workContent = await readWorkContent(dir, filepath);
    return createTwoFilesPatch(`a/${filepath}`, `b/${filepath}`, headContent, workContent);
  }

  const ops = {
    clone: async (url: string, dir: string) => {
      await git.clone({ ...network(dir, url), url, singleBranch: true, depth: 1 });
    },

    status: async (dir: string): Promise<GitStatusResult> => {
      const branch = (await git.currentBranch({ ...common(dir), fullname: false })) ?? null;
      const matrix = await git.statusMatrix(common(dir));
      const changes = matrix
        .filter(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
        .map(([filepath, head, workdir, stage]) => ({
          filepath,
          code: STATUS_CODES[`${head}${workdir}${stage}`] ?? '??',
        }));
      return { branch, changes };
    },

    listFiles: async (dir: string) => git.listFiles(common(dir)),

    diff: async (filepath: string, dir: string) => diffOne(dir, filepath),

    /** All working-tree changes vs HEAD (git diff without args). */
    diffAll: async (dir: string): Promise<string> => {
      const { changes } = await ops.status(dir);
      const parts: string[] = [];
      for (const { filepath } of changes) {
        parts.push(await diffOne(dir, filepath));
      }
      return parts.join('');
    },

    /** Staged changes vs HEAD (git diff --staged). */
    diffStaged: async (dir: string): Promise<string> => {
      const decoder = new TextDecoder();
      // STAGE walker entries expose oid but not content() — read blobs by oid.
      const blobText = async (oid: string | undefined): Promise<string> => {
        if (!oid) return '';
        const { blob } = await git.readBlob({ ...common(dir), oid });
        return decoder.decode(blob);
      };
      const results = await git.walk({
        ...common(dir),
        trees: [git.TREE({ ref: 'HEAD' }), git.STAGE()],
        map: async (filepath, [head, stage]) => {
          if (filepath === '.') return undefined;
          if ((await head?.type()) === 'tree' || (await stage?.type()) === 'tree') return undefined;
          const headOid = await head?.oid();
          const stageOid = await stage?.oid();
          if (headOid === stageOid) return undefined;
          const headText = await blobText(headOid);
          const stageText = await blobText(stageOid);
          return createTwoFilesPatch(`a/${filepath}`, `b/${filepath}`, headText, stageText);
        },
      });
      return (results as (string | undefined)[]).filter(Boolean).join('');
    },

    /** git add <path>|. — stages modifications, additions and deletions. */
    add: async (path: string, dir: string): Promise<string[]> => {
      const staged: string[] = [];
      if (path === '.' || path === '-A' || path === '--all') {
        const matrix = await git.statusMatrix(common(dir));
        for (const [filepath, head, workdir] of matrix) {
          if (head === 1 && workdir === 0) {
            await git.remove({ ...common(dir), filepath });
            staged.push(filepath);
          } else if (workdir === 2) {
            await git.add({ ...common(dir), filepath });
            staged.push(filepath);
          }
        }
      } else {
        const exists = await getFs()
          .promises.stat(`${dir}/${path}`)
          .then(() => true)
          .catch(() => false);
        if (exists) {
          await git.add({ ...common(dir), filepath: path });
        } else {
          await git.remove({ ...common(dir), filepath: path }); // stage a deletion
        }
        staged.push(path);
      }
      return staged;
    },

    /** git reset <path> — unstage (restore index entry to HEAD). */
    reset: async (path: string, dir: string) => {
      await git.resetIndex({ ...common(dir), filepath: path });
    },

    /** git rm <path> — remove from index and working tree. */
    rm: async (path: string, dir: string) => {
      await git.remove({ ...common(dir), filepath: path });
      await getFs()
        .promises.rm(`${dir}/${path}`)
        .catch(() => undefined); // already gone is fine
    },

    commit: async (message: string, dir: string): Promise<string> => {
      const matrix = await git.statusMatrix(common(dir));
      const hasStaged = matrix.some(([, head, , stage]) => !(head === 1 && stage === 1) && stage !== 0)
        || matrix.some(([, head, , stage]) => head === 1 && stage === 0);
      if (!hasStaged) throw new Error('nothing to commit (use "git add")');
      return git.commit({ ...common(dir), message, author: getAuthor() });
    },

    log: async (dir: string, opts: { depth?: number } = {}) => {
      const commits = await git.log({ ...common(dir), depth: opts.depth });
      return commits.map((c) => ({
        oid: c.oid,
        message: c.commit.message,
        author: c.commit.author.name,
        email: c.commit.author.email,
        timestamp: c.commit.author.timestamp,
      }));
    },

    branch: async (dir: string, opts: { all?: boolean } = {}) => {
      const current = (await git.currentBranch({ ...common(dir), fullname: false })) ?? null;
      const local = await git.listBranches(common(dir));
      let remote: string[] = [];
      if (opts.all) {
        remote = await git
          .listBranches({ ...common(dir), remote: 'origin' })
          .then((refs) => refs.filter((r) => r !== 'HEAD').map((r) => `remotes/origin/${r}`))
          .catch(() => []);
      }
      return { current, branches: [...local, ...remote] };
    },

    checkout: async (ref: string, dir: string, opts: { create?: boolean } = {}) => {
      if (opts.create) await git.branch({ ...common(dir), ref });
      await git.checkout({ ...common(dir), ref });
    },

    fetch: async (dir: string) => {
      const res = await git.fetch({ ...network(dir), singleBranch: false });
      return res.fetchHead;
    },

    /** Fast-forward-only pull (merge commits are out of scope — documented). */
    pull: async (dir: string) => {
      await git.pull({
        ...network(dir),
        fastForwardOnly: true,
        singleBranch: true,
        author: getAuthor(),
      });
    },

    push: async (dir: string): Promise<string> => {
      const res = await git.push(network(dir));
      if (res.ok) return 'Push complete.';
      throw new Error(res.error ?? 'push failed');
    },
  };
  return ops;
}

export type GitOps = ReturnType<typeof createGitOps>;

/** Browser-default instance over the ZenFS singleton (live binding). */
export const gitOps: GitOps = createGitOps(() => fs);
