#!/usr/bin/env node
/**
 * Static export of the sync demo UI (serve plan S2). App-router API routes
 * are not exportable, so `app/api/` is stashed aside for the build and
 * restored after — in this deployment `artipod serve` IS the API. Output
 * lands in `out/`; serve it with ARTIPOD_UI_DIR=out or import it into the
 * store: `artipod import out artipod-ui:latest`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rename, rm, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
const apiDir = join(root, 'app/api');
const stash = join(root, '.api-stash');

const restore = async () => {
  if (existsSync(stash)) await rename(stash, apiDir);
};

if (existsSync(stash)) {
  console.error('stale .api-stash found (a previous export crashed) — restoring it first');
  await restore();
}

await rename(apiDir, stash);
let code = 1;
try {
  // The file:../.. dep is COPIED into node_modules at install time and goes
  // stale silently (a 0.5.0 copy once shipped inside a 0.7.1 export) —
  // refresh it every export.
  console.log('refreshing the copied @artipod/core from ../.. …');
  await rm(join(root, 'node_modules/@artipod/core'), { recursive: true, force: true });
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status ?? 1);

  await rm(join(root, '.next'), { recursive: true, force: true });
  await rm(join(root, 'out'), { recursive: true, force: true });
  code = spawnSync('npx', ['next', 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, STATIC_EXPORT: '1' },
  }).status ?? 1;
} finally {
  await restore();
}
if (code !== 0) process.exit(code);

// Build assertion (plan §6): the ZenFS struct chunk must survive unminified —
// if the marker is gone from every chunk, the minifier ate the struct IIFEs.
const { readdirSync } = await import('node:fs');
const chunks = readdirSync(join(root, 'out/_next/static/chunks')).filter((f) => f.endsWith('.js'));
let found = false;
for (const chunk of chunks) {
  if ((await readFile(join(root, 'out/_next/static/chunks', chunk), 'utf8')).includes('Invalid name for struct field')) {
    found = true;
    break;
  }
}
if (!found) {
  console.error('export failed the struct-minify assertion: no chunk carries the ZenFS marker — SkipStructChunkMinify did not apply');
  process.exit(1);
}
console.log('static export ready in out/ (struct-minify assertion passed)');
