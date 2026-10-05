'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

(async () => {
  const root = path.join(__dirname, '..');
  const manifest = require('../package.json');
  const output = path.join(root, 'dist', `${manifest.name}-${manifest.version}.vsix`);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const cli = require.resolve('@vscode/vsce/vsce');
  const result = spawnSync(process.execPath, [cli, 'package', '--no-dependencies', '--baseContentUrl', 'https://github.com/mieweb/artipod/blob/artipod/vscode-extension/', '--out', output], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.error) { throw result.error; }
  if (result.status !== 0) { process.exitCode = result.status ?? 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
