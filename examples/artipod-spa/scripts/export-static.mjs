#!/usr/bin/env node
/**
 * Static export of the SPA (spa-ui-plan U0). Unlike the old app there is no
 * app/api to stash — output:'export' is unconditional. Output lands in
 * `out/`; serve it with ARTIPOD_UI_DIR=out or `artipod import out …`.
 * Assertions carried over from examples/artipod-sync: struct-minify marker,
 * baked version literal, ui-buildinfo.json provenance.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));

// The file:../.. dep is COPIED into node_modules at install time and goes
// stale silently — refresh it every export.
console.log('refreshing the copied @artipod/core from ../.. …');
await rm(join(root, 'node_modules/@artipod/core'), { recursive: true, force: true });
const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
if (install.status !== 0) process.exit(install.status ?? 1);

const rootVersion = JSON.parse(await readFile(join(root, '../../package.json'), 'utf8')).version;
const copiedVersion = JSON.parse(
  await readFile(join(root, 'node_modules/@artipod/core/package.json'), 'utf8'),
).version;
if (copiedVersion !== rootVersion) {
  console.error(`stale core copy: node_modules has ${copiedVersion}, the checkout is ${rootVersion} — refusing to export`);
  process.exit(1);
}

let fullVersion;
try {
  const info = JSON.parse(await readFile(join(root, 'node_modules/@artipod/core/dist/buildinfo.json'), 'utf8'));
  fullVersion = `${info.version ?? copiedVersion} (${info.commit ?? 'no-git'}, ${(info.date ?? '').slice(0, 10)})`;
} catch {
  fullVersion = copiedVersion; // gitless source tarball
}

// kerebron prep must run AFTER the install above (a fresh install restores
// pristine @kerebron css) and runs here because `npx next build` below
// bypasses npm lifecycle hooks — CI's export:static gets no prebuild.
const prep = spawnSync('node', [join(root, 'scripts/wasm-assets.mjs')], { cwd: root, stdio: 'inherit' });
if (prep.status !== 0) process.exit(prep.status ?? 1);

await rm(join(root, '.next'), { recursive: true, force: true });
await rm(join(root, 'out'), { recursive: true, force: true });
const code = spawnSync('npx', ['next', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NEXT_PUBLIC_ARTIPOD_VERSION: fullVersion },
}).status ?? 1;
if (code !== 0) process.exit(code);

const chunkDir = join(root, 'out/_next/static/chunks');
// Recursive: app-router page chunks live under chunks/app/….
const chunks = readdirSync(chunkDir, { recursive: true }).filter((f) => String(f).endsWith('.js'));
const chunkHas = async (needle) => {
  for (const chunk of chunks) {
    if ((await readFile(join(chunkDir, chunk), 'utf8')).includes(needle)) return true;
  }
  return false;
};

// Build assertion: the ZenFS struct chunk must survive unminified.
if (!(await chunkHas('Invalid name for struct field'))) {
  console.error('export failed the struct-minify assertion: no chunk carries the ZenFS marker — SkipStructChunkMinify did not apply');
  process.exit(1);
}
// Version assertion: a stale bundle can never ship silently.
if (!(await chunkHas(fullVersion))) {
  console.error(`export failed the version assertion: no chunk carries "${fullVersion}" — the bundle does not match the checkout`);
  process.exit(1);
}

// Provenance marker: serve reads this at boot and warns on version skew.
await writeFile(
  join(root, 'out/ui-buildinfo.json'),
  `${JSON.stringify({ coreVersion: fullVersion, builtAt: new Date().toISOString() })}\n`,
);
console.log(`static export ready in out/ (struct-minify + version assertions passed — ${fullVersion})`);
