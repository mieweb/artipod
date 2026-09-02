#!/usr/bin/env node
// Dev convenience: after a build, make the global `artipod` command point at
// this checkout (npm link), so `artipod serve` works instead of
// `node dist/cli.js serve`. Skipped in CI and when already linked here;
// failures (e.g. global-prefix permissions) warn but never break the build.
import { execSync } from 'node:child_process';
import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.CI || process.env.ARTIPOD_NO_DEVLINK) process.exit(0);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

try {
  // Fast path: is the globally linked package already this checkout?
  const globalRoot = sh('npm root -g');
  const linkPath = join(globalRoot, '@artipod/core');
  try {
    if (lstatSync(linkPath).isSymbolicLink() && resolve(dirname(linkPath), readlinkSync(linkPath)) === repoRoot) {
      process.exit(0);
    }
  } catch {
    // not linked yet
  }
  execSync('npm link --no-audit --no-fund', { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] });
  console.log("devlink: global `artipod` now runs this checkout (set ARTIPOD_NO_DEVLINK=1 to opt out)");
} catch (e) {
  console.warn(`devlink: npm link skipped (${e.message.split('\n')[0]}) — use \`node dist/cli.js\` or link manually`);
}
