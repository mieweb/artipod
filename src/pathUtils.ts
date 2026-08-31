/**
 * Dependency-free posix path helpers for the isomorphic core.
 *
 * Pod paths are posix by contract (container bind mounts, ZenFS and OCI
 * layers all speak '/'); Node callers on Windows pass forward-slash paths.
 * Pure string ops — removes the `node:path` import that broke browser
 * bundles (Next/Vite don't polyfill node builtins).
 */

/** Collapse '.', '..' and duplicate slashes; result keeps a single leading '/'. */
export function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return '/' + out.join('/');
}

/**
 * posix `path.resolve`: right-most absolute segment wins; relative inputs
 * resolve against `process.cwd()` in Node and throw elsewhere (browsers must
 * pass absolute pod paths).
 */
export function resolvePosix(...segments: string[]): string {
  let acc = '';
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (!seg) continue;
    acc = acc ? `${seg}/${acc}` : seg;
    if (seg.startsWith('/')) return normalizePosix(acc);
  }
  if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
    return normalizePosix(`${process.cwd().replace(/\\/g, '/')}/${acc}`);
  }
  throw new Error(`Cannot resolve relative path '${segments.join(', ')}' without process.cwd(); pass an absolute path`);
}

/** posix `path.join` for '..'-free segments (mount-internal joins). */
export function joinPosix(...segments: string[]): string {
  const parts = segments.filter(Boolean);
  const joined = parts.join('/');
  if (!joined) return '.';
  const abs = joined.startsWith('/');
  const normalized = normalizePosix(joined).slice(1);
  return abs ? `/${normalized}` : normalized || '.';
}

/** posix `path.dirname`. */
export function dirnamePosix(p: string): string {
  const n = p.length > 1 ? p.replace(/\/+$/, '') : p;
  const idx = n.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return n.slice(0, idx);
}

/** posix `path.relative` for absolute paths. */
export function relativePosix(from: string, to: string): string {
  const f = normalizePosix(from).split('/').filter(Boolean);
  const t = normalizePosix(to).split('/').filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/');
}
