import { applicationPath, parseExecutableDescriptor } from './descriptor.js';
import type { ApplicationSource } from './capture.js';

export interface ApplicationFiles {
  read(path: string): Promise<Uint8Array>;
  list(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number; isDirectory(): boolean; isSymbolicLink(): boolean }>;
}

const excluded = new Set(['.artipod', '.git', 'node_modules', 'case']);

export async function applicationSource(files: ApplicationFiles, root: string): Promise<ApplicationSource> {
  const base = root.replace(/\/$/, '');
  const paths: string[] = [];
  let entries = 0;
  let total = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 12) throw new Error('Application tree too deep');
    for (const name of await files.list(`${base}${relative ? `/${relative}` : ''}`)) {
      if (++entries > 256) throw new Error('Application has too many entries');
      if (excluded.has(name)) continue;
      const path = applicationPath(relative ? `${relative}/${name}` : name);
      const stat = await files.stat(`${base}/${path}`);
      if (stat.isSymbolicLink()) throw new Error('Application symlinks are not supported');
      if (stat.isDirectory()) await walk(path, depth + 1);
      else {
        total += stat.size;
        if (stat.size > 1024 * 1024 || total > 8 * 1024 * 1024 || paths.length >= 128) throw new Error('Application too large');
        paths.push(`/app/${path}`);
      }
    }
  };
  const rootStat = await files.stat(base || '/');
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Invalid application root');
  await walk('', 0);
  return {
    paths,
    async read(path) {
      if (!paths.includes(path)) throw new Error('Unprojected application path');
      const relative = applicationPath(path);
      let parent = base;
      for (const segment of relative.split('/')) {
        parent += `/${segment}`;
        if ((await files.stat(parent)).isSymbolicLink()) throw new Error('Application path changed to a symlink');
      }
      return new Uint8Array(await files.read(`${base}/${relative}`));
    },
  };
}

export async function inspectApplication(files: ApplicationFiles, root: string) {
  const path = `${root.replace(/\/$/, '')}/artipod.json`;
  const stat = await files.stat(path);
  if (stat.isSymbolicLink() || stat.isDirectory() || stat.size > 65536) throw new Error('Invalid application descriptor');
  return parseExecutableDescriptor(await files.read(path));
}