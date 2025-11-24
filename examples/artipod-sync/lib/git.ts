import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { fs } from './filesystem';
import { createTwoFilesPatch } from 'diff';

const CORS_PROXY = 'https://cors.isomorphic-git.org';

export interface GitStatus {
  filepath: string;
  status: string;
}

export const gitOps = {
  clone: async (url: string, dir: string = '/repo') => {
    console.log(`Cloning ${url} to ${dir}...`);
    await git.clone({
      fs,
      http,
      dir,
      url,
      corsProxy: CORS_PROXY,
      singleBranch: true,
      depth: 1,
    });
    console.log('Clone complete.');
  },

  status: async (dir: string = '/repo') => {
    const matrix = await git.statusMatrix({
      fs,
      dir,
    });
    
    // Map status matrix to readable strings
    // [file, HEAD, WORKDIR, STAGE]
    return matrix.map(row => {
      const [filepath, head, workdir, stage] = row;
      let status = '';
      if (head === 1 && workdir === 1 && stage === 1) status = 'unmodified';
      else if (head === 0 && workdir === 2 && stage === 0) status = 'new'; // untracked
      else if (head === 1 && workdir === 2 && stage === 1) status = 'modified';
      else if (head === 1 && workdir === 2 && stage === 2) status = 'modified (staged)';
      else if (head === 1 && workdir === 2 && stage === 3) status = 'modified (staged & unstaged)';
      else if (head === 1 && workdir === 0) status = 'deleted';
      else status = 'unknown'; // simplify for PoC

      return { filepath, status };
    }).filter(s => s.status !== 'unmodified');
  },

  listFiles: async (dir: string = '/repo') => {
    return await git.listFiles({
      fs,
      dir,
    });
  },

  diff: async (filepath: string, dir: string = '/repo') => {
    // Get HEAD content
    let headContent = '';
    try {
      const commitOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
      const { blob } = await git.readBlob({
        fs,
        dir,
        oid: commitOid,
        filepath,
      });
      headContent = new TextDecoder().decode(blob);
    } catch (e) {
      // File might be new
      headContent = '';
    }

    // Get Working Directory content
    let workContent = '';
    try {
      workContent = await fs.promises.readFile(`${dir}/${filepath}`, 'utf8') as string;
    } catch (e) {
      // File might be deleted
      workContent = '';
    }

    return createTwoFilesPatch(
      `a/${filepath}`,
      `b/${filepath}`,
      headContent,
      workContent
    );
  }
};
