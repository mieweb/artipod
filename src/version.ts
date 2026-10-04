/**
 * The running core's version, as one string for the CLI banner, `uname -r`,
 * the server identity and the UI skew check: `0.10.1+21 (71f2ed7, 2026-09-06)`
 * when postbuild baked dist/buildinfo.json, else the plain package version.
 * Node-only (reads files beside dist/); browsers get NEXT_PUBLIC_ARTIPOD_VERSION.
 */
import { readFile } from 'node:fs/promises';

let cached: Promise<string> | null = null;

export function coreVersion(): Promise<string> {
  cached ??= (async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    let version = pkg.version;
    let build = '';
    try {
      const bi = JSON.parse(await readFile(new URL('./buildinfo.json', import.meta.url), 'utf8')) as {
        version?: string | null;
        commit?: string | null;
        date?: string | null;
      };
      if (bi.version) version = bi.version;
      const parts = [bi.commit, bi.date?.slice(0, 10)].filter(Boolean);
      if (parts.length > 0) build = ` (${parts.join(', ')})`;
    } catch {
      // no buildinfo baked — version only
    }
    return `${version}${build}`;
  })();
  return cached;
}
