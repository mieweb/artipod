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
let fullVersion = '';
try {
  // The file:../.. dep is COPIED into node_modules at install time and goes
  // stale silently (a 0.5.0 copy once shipped inside a 0.7.1 export) —
  // refresh it every export.
  console.log('refreshing the copied @artipod/core from ../.. …');
  await rm(join(root, 'node_modules/@artipod/core'), { recursive: true, force: true });
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
  if (install.status !== 0) process.exit(install.status ?? 1);

  // Belt AND suspenders: the copy must be byte-for-byte the checkout's version.
  const rootVersion = JSON.parse(await readFile(join(root, '../../package.json'), 'utf8')).version;
  const copiedVersion = JSON.parse(
    await readFile(join(root, 'node_modules/@artipod/core/package.json'), 'utf8'),
  ).version;
  if (copiedVersion !== rootVersion) {
    console.error(`stale core copy: node_modules has ${copiedVersion}, the checkout is ${rootVersion} — refusing to export`);
    process.exit(1);
  }

  // Dev builds carry the auto-bumped version + commit + date (dist/buildinfo.json,
  // baked by the core build) — "0.7.1+10 (ee5c01b-dirty, 2026-09-02)", not "0.7.1".
  try {
    const info = JSON.parse(await readFile(join(root, 'node_modules/@artipod/core/dist/buildinfo.json'), 'utf8'));
    fullVersion = `${info.version ?? copiedVersion} (${info.commit ?? 'no-git'}, ${(info.date ?? '').slice(0, 10)})`;
  } catch {
    fullVersion = copiedVersion; // gitless source tarball
  }

  await rm(join(root, '.next'), { recursive: true, force: true });
  await rm(join(root, 'out'), { recursive: true, force: true });
  code = spawnSync('npx', ['next', 'build'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, STATIC_EXPORT: '1', NEXT_PUBLIC_ARTIPOD_VERSION: fullVersion },
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

// Version assertion: NEXT_PUBLIC_ARTIPOD_VERSION is inlined at build time,
// so the FULL dev version (incl. commit + date) must appear as a literal —
// a stale bundle can never ship silently again.
let versionBaked = false;
for (const chunk of chunks) {
  if ((await readFile(join(root, 'out/_next/static/chunks', chunk), 'utf8')).includes(fullVersion)) {
    versionBaked = true;
    break;
  }
}
if (!versionBaked) {
  console.error(`export failed the version assertion: no chunk carries "${fullVersion}" — the bundle does not match the checkout`);
  process.exit(1);
}

// Provenance marker: serve reads this at boot and warns on version skew.
const { writeFile } = await import('node:fs/promises');
await writeFile(
  join(root, 'out/ui-buildinfo.json'),
  `${JSON.stringify({ coreVersion: fullVersion, builtAt: new Date().toISOString() })}\n`,
);
console.log(`static export ready in out/ (struct-minify + version assertions passed — ${fullVersion})`);
