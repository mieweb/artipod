'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

(async () => {
  const root = path.join(__dirname, '..');
  const manifest = require('../package.json');
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--pre-release')) {
    throw new Error('Usage: npm run package:vsix -- [--pre-release]');
  }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) { throw new Error('Cannot determine package source revision'); }
  const output = path.join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const cli = require.resolve('@vscode/vsce/vsce');
  const source = `https://github.com/mieweb/artipod/blob/${revision}/vscode-extension/`;
  const result = spawnSync(process.execPath, [cli, 'package', '--no-dependencies', '--baseContentUrl', source, '--out', output, ...args], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.error) { throw result.error; }
  if (result.status !== 0) { process.exitCode = result.status ?? 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
