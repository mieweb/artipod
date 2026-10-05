'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

async function packageAt(directory) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
    return manifest.name && manifest.version ? { directory, manifest } : undefined;
  } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
}

async function owningPackage(filename) {
  let directory = path.dirname(path.resolve(filename));
  while (true) {
    const result = await packageAt(directory);
    if (result) { return result; }
    const parent = path.dirname(directory);
    if (parent === directory) { throw new Error(`No package owns ${filename}`); }
    directory = parent;
  }
}

async function resolvePackage(name, from) {
  let directory = from;
  while (true) {
    const result = await packageAt(path.join(directory, 'node_modules', name));
    if (result) { return result; }
    const parent = path.dirname(directory);
    if (parent === directory) { throw new Error(`Cannot resolve ${name} from ${from}`); }
    directory = parent;
  }
}

async function dependencyClosure(initial) {
  const packages = new Map();
  const visit = async item => {
    if (packages.has(item.directory)) { return; }
    packages.set(item.directory, item);
    const names = new Set([...Object.keys(item.manifest.dependencies || {}), ...Object.keys(item.manifest.peerDependencies || {})]);
    for (const name of names) {
      if (item.manifest.peerDependenciesMeta?.[name]?.optional) { continue; }
      await visit(await resolvePackage(name, item.directory));
    }
  };
  for (const item of initial) { await visit(item); }
  return packages;
}

async function applyCompatibilityPatch(item, target, destination) {
  if (item.manifest.name !== '@zenfs/core') { return; }
  const patchName = 'zenfs-core-2.4.4-module-version';
  const patch = JSON.parse(await fs.readFile(path.join(__dirname, 'patches', `${patchName}.json`), 'utf8'));
  if (item.manifest.version !== patch.version) {
    throw new Error(`Review the ZenFS compatibility patch before packaging ${item.manifest.name}@${item.manifest.version}`);
  }
  const file = path.join(target, patch.path);
  const source = await fs.readFile(file, 'utf8');
  if (source.split(patch.original).length !== 2) {
    throw new Error(`The ZenFS compatibility patch no longer matches ${patch.path}; review the upstream source before packaging`);
  }
  await fs.writeFile(file, source.replace(patch.original, patch.replacement));
  const line = source.slice(0, source.indexOf(patch.original)).split('\n').length;
  const replacement = patch.replacement.split('\n');
  const diff = [
    `Artipod modification dated ${patch.date}: ${patch.reason}`, '',
    `--- a/${patch.path}`, `+++ b/${patch.path}`,
    `@@ -${line},1 +${line},${replacement.length} @@`,
    `-${patch.original}`, ...replacement.map(value => `+${value}`), ''
  ].join('\n');
  await fs.mkdir(path.join(destination, 'patches'), { recursive: true });
  await fs.writeFile(path.join(destination, 'patches', `${patchName}.patch`), diff);
}

async function copyReplaceableLibraries(root, destination) {
  const packages = await dependencyClosure(await Promise.all(['@zenfs/core', '@zenfs/dom'].map(name => resolvePackage(name, root))));
  const modules = path.join(root, 'node_modules');
  await fs.rm(path.join(destination, 'node_modules'), { recursive: true, force: true });
  for (const item of packages.values()) {
    const { directory } = item;
    const relative = path.relative(modules, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { throw new Error(`Dependency lies outside the lockfile tree: ${directory}`); }
    const target = path.join(destination, 'node_modules', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(directory, target, {
      recursive: true,
      filter: source => source === directory || !path.relative(directory, source).split(path.sep).includes('node_modules')
    });
    await applyCompatibilityPatch(item, target, destination);
  }
  return packages;
}

function repositoryUrl(manifest) {
  const value = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  let url = (value || manifest.homepage || `https://www.npmjs.com/package/${manifest.name}`).replace(/^git\+/, '').replace(/\.git$/, '');
  url = url.replace(/^git:\/\//, 'https://').replace(/^git@([^:]+):/, 'https://$1/').replace(/^github:/, 'https://github.com/');
  if (/^[^/:]+\/[^/]+$/.test(url)) { url = `https://github.com/${url}`; }
  return url;
}

async function licenseTexts(item) {
  const entries = await fs.readdir(item.directory, { withFileTypes: true });
  const names = entries.filter(entry => entry.isFile() && /^(licen[cs]e|copying|notice|copyright)([.-]|$)/i.test(entry.name)).map(entry => entry.name).sort();
  const result = await Promise.all(names.map(async name => ({ name, text: await fs.readFile(path.join(item.directory, name), 'utf8') })));
  if (item.manifest.name === 'diff3') {
    for (const name of ['diff3.js', 'onp.js']) {
      const source = await fs.readFile(path.join(item.directory, name), 'utf8');
      const header = source.match(/^(?:\/\/[^\n]*\n)+/);
      if (header) { result.push({ name: `${name} copyright and license header`, text: header[0] }); }
    }
  }
  const supplemental = path.join(__dirname, 'licenses', `${item.manifest.name.replaceAll('/', '__')}-${item.manifest.version}.txt`);
  try { result.push({ name: 'Supplemental upstream license', text: await fs.readFile(supplemental, 'utf8') }); }
  catch (error) { if (error.code !== 'ENOENT') { throw error; } }
  if (!result.length && ['MIT', 'Apache-2.0'].includes(item.manifest.license)) {
    const standard = await fs.readFile(path.join(__dirname, 'licenses', `${item.manifest.license}.txt`), 'utf8');
    result.push({ name: 'License declared by upstream package metadata', text: `This npm package does not ship a standalone license file. Its package.json declares ${item.manifest.license}.\nAuthor metadata: ${JSON.stringify(item.manifest.author || 'not supplied')}\n\n${standard}` });
  }
  if (!result.length) { throw new Error(`Missing license text for ${item.manifest.name}@${item.manifest.version}; add a pinned upstream copy in scripts/licenses`); }
  return result;
}

async function writeNotices(root, extension, metafile, replaceable) {
  const packages = new Map(replaceable);
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.includes('node_modules/')) { continue; }
    const item = await owningPackage(path.resolve(extension, input));
    packages.set(item.directory, item);
  }
  // just-bash ships a prebundled browser entrypoint. Its required dependency
  // closure carries notices that cannot be discovered from esbuild inputs alone.
  const shellClosure = await dependencyClosure([await resolvePackage('just-bash', root)]);
  for (const [directory, item] of shellClosure) { packages.set(directory, item); }
  const unique = new Map([...packages.values()].map(item => [`${item.manifest.name}@${item.manifest.version}`, item]));
  const ordered = [...unique.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name) || a.manifest.version.localeCompare(b.manifest.version));
  const lines = [
    '# Third-party notices', '',
    'Generated by `npm run prepare-backend` from the pinned runtime dependency graph.',
    'Includes notices for the required dependency closure of the prebundled just-bash browser runtime; some of those modules are not exercised by this extension.', '',
    'Artipod extension and backend source is MIT licensed; see LICENSE. Each third-party component retains its own license.',
    'The LGPL libraries and their dependency tree remain separate, replaceable JavaScript modules under `vendor/node_modules`. See SOURCES.md for replacement and rebuild instructions.', '',
    'Artipod modifies one initialization statement in @zenfs/core 2.4.4 for compatibility with Electron Node 24.21. The modified source includes a dated notice; the exact patch is supplied in vendor/patches/zenfs-core-2.4.4-module-version.patch. All other copied library source is unchanged.', ''
  ];
  const sources = ['# Runtime sources and rebuilding', '',
    'The extension source is https://github.com/mieweb/artipod/tree/artipod/vscode-extension. The Artipod backend source is https://github.com/mieweb/artipod/tree/artipod/src.', '',
    '## Replaceable libraries', '',
    '`@zenfs/core`, `@zenfs/dom`, `utilium`, and `memium` retain their LGPL licenses. Their JavaScript is shipped as separate modules under `vendor/node_modules`, with the exact nested dependency versions from the root package-lock.json. They are not statically included in the worker bundles. You may inspect, modify, or replace those modules with interface-compatible versions in an unpacked VSIX and reload VS Code; no integrity check prevents replacement. Keep nested dependencies compatible. This distribution imposes no restriction on modification or reverse engineering for debugging changes to those libraries.', '',
    '## ZenFS compatibility modification', '',
    'Artipod changes @zenfs/core 2.4.4 dist/index.js on 2026-10-04. Electron Node 24.21 rejects Object.assign when its target inherits from an ESM module namespace. The change uses Object.defineProperty to define an own _version property while preserving the filesystem namespace prototype and writable/enumerable/configurable property behavior. The upstream npm package remains untouched in the source checkout; only the copied VSIX library is modified.', '',
    'The exact unified source patch is included at `vendor/patches/zenfs-core-2.4.4-module-version.patch`. Its reproducible patch specification is `scripts/patches/zenfs-core-2.4.4-module-version.json` in the extension source repository. Packaging checks the exact package version and original statement, and stops if either changes. The modified source retains its LGPL-3.0-or-later license and has a dated modification notice. Other copied libraries are unmodified.', '',
    '## Rebuild the extension', '',
    'Use Node.js 22 or later and the repository commit supplied with the release. From the repository root:', '',
    '```sh', 'npm ci', 'npm run build', 'cd vscode-extension', 'npm ci', 'npm test', 'npm run package:vsix', '```', '',
    'The checked-in lockfiles pin the application and packaging dependencies. `prepare-backend` regenerates worker bundles, copies the replaceable library tree, applies the checked ZenFS compatibility patch, and writes these notices. `package:vsix` builds and packages only; it does not publish. Output is `dist/artipod-0.1.0.vsix`.', '',
    'To rebuild against a modified library source, build that library using its upstream instructions, replace its installed package in the Artipod repository node_modules tree, then rerun `npm run prepare-backend` in vscode-extension. Then run `npm run package:vsix`; this rebuilds against the installed dependency tree and does not reinstall or replace your modified library.', '',
    '## Exact npm package archives', '',
    'These archives identify the versions included or whose notices accompany the prebundled shell. Upstream repositories contain development source and build instructions. The npm archives contain the JavaScript modules shipped by each package.', '',
    '| Package | License | Repository | Versioned archive |', '| --- | --- | --- | --- |'
  ];
  for (const item of ordered) {
    const { manifest } = item;
    const name = `${manifest.name}@${manifest.version}`;
    const repo = repositoryUrl(manifest);
    const archive = `https://registry.npmjs.org/${manifest.name}/-/${manifest.name.split('/').pop()}-${manifest.version}.tgz`;
    lines.push(`## ${name}`, '', `License: ${manifest.license || 'See license below'}`, '', `Source: ${repo}`, '', `Package archive: ${archive}`, '');
    for (const notice of await licenseTexts(item)) { lines.push(`### ${notice.name}`, '', '```text', notice.text.trimEnd(), '```', ''); }
    sources.push(`| ${name} | ${manifest.license || 'See notices'} | [source](${repo}) | [archive](${archive}) |`);
  }
  lines.push('## GNU GPL version 3 (incorporated by LGPL version 3)', '', '```text', (await fs.readFile(path.join(__dirname, 'licenses', 'GPL-3.0-only.txt'), 'utf8')).trimEnd(), '```', '');
  await fs.writeFile(path.join(extension, 'THIRD_PARTY_NOTICES.md'), lines.join('\n').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n');
  await fs.writeFile(path.join(extension, 'SOURCES.md'), sources.join('\n') + '\n');
}

module.exports = { copyReplaceableLibraries, writeNotices };
