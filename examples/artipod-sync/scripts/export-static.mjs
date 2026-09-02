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

  // Belt AND suspenders: the copy must be byte-for-byte the checkout's version.
  const rootVersion = JSON.parse(await readFile(join(root, '../../package.json'), 'utf8')).version;
  const copiedVersion = JSON.parse(
    await readFile(join(root, 'node_modules/@artipod/core/package.json'), 'utf8'),
  ).version;
  if (copiedVersion !== rootVersion) {
    console.error(`stale core copy: node_modules has ${copiedVersion}, the checkout is ${rootVersion} — refusing to export`);
    process.exit(1);
  }

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

// Version assertion: the bundled banner must carry the checkout's core
// version — a stale bundle can never ship silently again. Minifiers split
// the template into .concat("0.7.1") pieces, so match both fragments.
const version = JSON.parse(await readFile(join(root, 'node_modules/@artipod/core/package.json'), 'utf8')).version;
let versionBaked = false;
for (const chunk of chunks) {
  const source = await readFile(join(root, 'out/_next/static/chunks', chunk), 'utf8');
  if (source.includes('@artipod/core ') && source.includes(`"${version}"`)) {
    versionBaked = true;
    break;
  }
}
if (!versionBaked) {
  console.error(`export failed the version assertion: no chunk carries "@artipod/core ${version}" — the bundle does not match the checkout`);
  process.exit(1);
}

// Provenance marker: serve reads this at boot and warns on version skew.
const { writeFile } = await import('node:fs/promises');
await writeFile(
  join(root, 'out/ui-buildinfo.json'),
  `${JSON.stringify({ coreVersion: version, builtAt: new Date().toISOString() })}\n`,
);
console.log(`static export ready in out/ (struct-minify + version ${version} assertions passed)`);
