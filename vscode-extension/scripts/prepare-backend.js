'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
const { isBuiltin } = require('node:module');
const { copyReplaceableLibraries, writeNotices } = require('./package-dependencies');

(async () => {
  const extension = path.join(__dirname, '..');
  const destination = path.join(extension, 'vendor');
  await fs.mkdir(destination, { recursive: true });
  const root = path.join(extension, '..');
  // Keep LGPL libraries separately replaceable. All runtime dependencies still
  // ship inside vendor; neither global packages nor an Artipod CLI are needed.
  const replaceable = await copyReplaceableLibraries(root, destination);
  const result = await esbuild.build({
    absWorkingDir: extension,
    entryPoints: {
      checkpoints: path.join(root, 'dist', 'checkpoint-workspace.js'),
      'checkpoint-worker': path.join(root, 'dist', 'checkpoint-worker.js'),
      'terminal-worker': path.join(extension, 'terminal-worker.mjs')
    },
    outdir: destination,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@zenfs/core', '@zenfs/dom'],
    sourcemap: false,
    banner: { js: "import { createRequire as __artipodCreateRequire } from 'node:module'; const require = __artipodCreateRequire(import.meta.url);" },
    logLevel: 'warning',
    metafile: true
  });
  const external = Object.values(result.metafile.outputs).flatMap(output => output.imports)
    .filter(item => item.external && !isBuiltin(item.path) && !/^@zenfs\/(core|dom)(\/|$)/.test(item.path));
  if (external.length) { throw new Error(`Unpackaged Artipod dependencies: ${external.map(item => item.path).join(', ')}`); }
  await fs.rename(path.join(destination, 'checkpoints.js'), path.join(destination, 'checkpoints.mjs'));
  await fs.writeFile(path.join(destination, 'package.json'), '{"type":"module"}\n');
  await writeNotices(root, extension, result.metafile, replaceable);
})().catch(error => { console.error(error); process.exitCode = 1; });
