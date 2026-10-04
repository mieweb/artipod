#!/usr/bin/env node
// Bakes dist/buildinfo.json at build time; the CLI shows it in --version/--help.
// Git-less builds (e.g. source tarballs) fall back to the build date alone.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const git = (cmd) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
};

let commit = git('git rev-parse --short HEAD');
if (commit && git('git status --porcelain -uno')) commit += '-dirty';
const date = git('git show -s --format=%cI HEAD') ?? new Date().toISOString();

// Auto-bumped version: latest tag, plus the commits since it (0.3.1+5).
let version = null;
const described = git('git describe --tags --long');
const m = described?.match(/^(.+)-(\d+)-g[0-9a-f]+$/);
if (m) version = Number(m[2]) > 0 ? `${m[1]}+${m[2]}` : m[1];

writeFileSync(new URL('../dist/buildinfo.json', import.meta.url), `${JSON.stringify({ version, commit, date })}\n`);
