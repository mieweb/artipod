/**
 * /server is node-only: the package must declare it browser-false and no
 * browser-reachable module may import it (sync plan Phase B, Decision D2 —
 * same pattern as /docker). Pinned at the source level, where bundlers
 * make their decisions.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = join(root, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('server subpath isolation', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports: Record<string, unknown>;
    browser: Record<string, unknown>;
  };

  it('is exported and mapped to false for browser bundles', () => {
    expect(pkg.exports['./server']).toBeTruthy();
    expect(pkg.browser['./dist/server/index.js']).toBe(false);
  });

  it('is imported by nothing outside src/server', () => {
    const offenders = walk(srcDir)
      .filter((f) => !f.includes(`${join('src', 'server')}`) && !f.endsWith('.test.ts') && !f.endsWith('.spec.ts'))
      // cli.ts is the node-only bin entry (imports node:* statically, never browser-bundled)
      .filter((f) => f !== join(srcDir, 'cli.ts'))
      .filter((f) => /from\s+['"][./]*\/server\//.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
