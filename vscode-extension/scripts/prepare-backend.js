'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
const { isBuiltin } = require('node:module');

(async () => {
  const destination = path.join(__dirname, '..', 'vendor');
  await fs.mkdir(destination, { recursive: true });
  const root = path.join(__dirname, '..', '..');
  // Workers resolve their sibling entrypoints relative to import.meta.url.
  // Bundle every runtime dependency, including ZenFS and just-bash, so a VSIX
  // never imports the developer's checkout or relies on a global Artipod CLI.
  await esbuild.build({
    entryPoints: {
      checkpoints: path.join(root, 'dist', 'checkpoint-workspace.js'),
      'checkpoint-worker': path.join(root, 'dist', 'checkpoint-worker.js'),
      'terminal-worker': path.join(root, 'vscode-extension', 'terminal-worker.mjs')
    },
    outdir: destination,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    // Some dependencies still use CommonJS internals inside an ESM bundle.
    banner: { js: "import { createRequire as __artipodCreateRequire } from 'node:module'; const require = __artipodCreateRequire(import.meta.url);" },
    logLevel: 'warning',
    metafile: true
  }).then(result => {
    const external = Object.values(result.metafile.outputs).flatMap(output => output.imports)
      .filter(item => item.external && !isBuiltin(item.path));
    if (external.length) { throw new Error(`Unbundled Artipod dependencies: ${external.map(item => item.path).join(', ')}`); }
  });
  await fs.rename(path.join(destination, 'checkpoints.js'), path.join(destination, 'checkpoints.mjs'));
  await fs.writeFile(path.join(destination, 'package.json'), '{"type":"module"}\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
