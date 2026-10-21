#!/usr/bin/env node
/**
 * Tests an npm-packed installation, never checkout source aliases. Build core
 * first. Browser checks host their own disposable localhost page; no SPA or
 * artipod server is used. --node-only omits Chromium, --browser-only omits Node.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { observePersistence } from './observer.mjs';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), 'artipod-packed-storage-'));
let consumer = join(temporary, 'consumer');
const nodeOnly = process.argv.includes('--node-only');
const browserOnly = process.argv.includes('--browser-only');
assert(!(nodeOnly && browserOnly), 'Select either --node-only or --browser-only');
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`, ARTIPOD_NO_DEVLINK: '1' };
const reports = [];
let server;
let browser;

async function command(binary, args, cwd) {
  try {
    const result = await execute(binary, args, { cwd, env, maxBuffer: 8 * 1024 * 1024, timeout: 180_000 });
    return result.stdout;
  } catch (error) {
    throw new Error(`${binary} ${args[0] ?? ''} failed\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error });
  }
}
function report(value) { reports.push(value); process.stdout.write(`[storage-consumer] ${JSON.stringify(value)}\n`); }

try {
  await cp(join(root, 'test/storage-consumer'), consumer, { recursive: true });
  consumer = await realpath(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'artipod-storage-consumer-fixture', private: true, type: 'module' }));
  const packed = JSON.parse(await command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], root))[0];
  for (const path of ['dist/storage/index.js', 'dist/storage/index.d.ts', 'dist/storage/node.js', 'dist/storage/node.d.ts']) {
    assert(packed.files.some(file => file.path === path), `Published package is missing ${path}`);
  }
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const peers = Object.keys(packageJson.peerDependencies).filter(name => !packageJson.peerDependenciesMeta?.[name]?.optional)
    .map(name => `${name}@${packageJson.devDependencies[name] ?? packageJson.peerDependencies[name]}`);
  await command('npm', ['install', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund', join(temporary, packed.filename), ...peers, 'buffer@6.0.3'], consumer);
  const resolved = JSON.parse(await command(process.execPath, ['--input-type=module', '-e', `console.log(JSON.stringify(['@artipod/core','@artipod/core/storage','@artipod/core/storage/node','@artipod/core/oci'].map(name => import.meta.resolve(name))))`], consumer));
  for (const path of resolved) assert(path.startsWith(pathToFileURL(join(consumer, 'node_modules/@artipod/core/')).href), `Public entry resolved outside the packed install: ${path}`);
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', lib: ['ES2022', 'DOM'], strict: true, skipLibCheck: true, noEmit: true, types: [] }, files: ['typecheck.ts'] }));
  await command(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], consumer);
  report({ packedPublicExports: resolved.length, declarations: 'passed' });

  if (!browserOnly) {
    const result = await command(process.execPath, ['native.mjs'], consumer);
    process.stdout.write(result);
    reports.push(JSON.parse(result.trim().split('\n').at(-1)));
  }

  if (!nodeOnly) {
    const { build } = require('esbuild');
    // just-bash 3.4.2's browser entry retains gzip/gunzip imports from
    // node:zlib. Supply the browser implementation from its public peer;
    // all @artipod imports still resolve untouched through the packed exports.
    const bundle = await build({ absWorkingDir: consumer, entryPoints: ['browser.mjs'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022', alias: { 'node:zlib': './zlib-browser.mjs' }, metafile: true });
    for (const input of Object.keys(bundle.metafile.inputs)) {
      assert(resolve(consumer, input).startsWith(`${consumer}/`), `Browser fixture imported outside the installed consumer: ${input}`);
      if (input.includes('node_modules/@artipod/core/')) assert(input.includes('node_modules/@artipod/core/dist/'), `Browser fixture imported unpublished core source: ${input}`);
    }
    assert(Object.keys(bundle.metafile.inputs).some(input => input.includes('node_modules/@artipod/core/dist/storage/')), 'Browser bundle did not consume the installed storage export');
    server = createServer((request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', request.url === '/consumer.js' ? 'text/javascript' : 'text/html');
      response.end(request.url === '/consumer.js' ? bundle.outputFiles[0].contents : '<!doctype html><meta charset="utf-8"><script src="/consumer.js"></script>');
    });
    await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
    const url = `http://127.0.0.1:${server.address().port}`;
    let playwright;
    try { playwright = process.env.PLAYWRIGHT_MODULE_PATH ? require(resolve(process.env.PLAYWRIGHT_MODULE_PATH)) : require('playwright'); }
    catch (error) {
      if (!process.env.PLAYWRIGHT_MODULE_PATH) throw new Error('Install Playwright or set PLAYWRIGHT_MODULE_PATH for standalone browser checks', { cause: error });
      playwright = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
    }
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
    for (const backend of ['opfs', 'indexeddb']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const id = randomUUID();
      const markerNames = ['directory', 'filename', 'payload', 'target', 'link', 'label', 'ref', 'metadata'];
      // Obtain marker construction through the consumer after load, while the
      // observer already knows the complete strings before any package code.
      const markers = Object.fromEntries(markerNames.map(name => [name, `${name === 'target' ? 'private-link-target' : name === 'link' ? 'private-link' : name === 'label' ? 'private-snapshot-label' : `private-${name}`}-${id}${name === 'filename' || name === 'target' ? '.txt' : name === 'ref' ? ':1' : ''}`]));
      const canary = `persistence-canary-${id}`;
      await page.addInitScript(observePersistence, { markers: Object.values(markers), canary });
      try {
        await page.goto(url);
        await page.waitForFunction(() => !!globalThis.storageConsumer);
        assert.deepEqual(await page.evaluate(id => storageConsumer.markersFor(id), id), markers);
        const canaries = await page.evaluate(() => persistenceObserver.canary());
        assert(canaries.some(event => event.operation.startsWith('opfs-')), 'Temporary OPFS write escaped the observer');
        assert(canaries.some(event => event.operation === 'idb-write'), 'Temporary IDB write escaped the observer');
        assert(canaries.some(event => event.operation === 'idb-key'), 'IDB keys escaped the observer');
        assert(canaries.some(event => event.operation === 'web-storage-write'), 'Temporary web storage write escaped the observer');
        const policies = await page.evaluate(() => storageConsumer.rejectUnsafePolicies());
        const bytes = [...randomBytes(32)];
        const saved = await page.evaluate(({ backend, bytes, markers }) => storageConsumer.write(backend, bytes, markers), { backend, bytes, markers });
        const first = await page.evaluate(() => persistenceObserver.scan());
        assert.deepEqual(first.leaks, [], 'A protected first write exposed private metadata');
        assert(first.encryptedBlocks > 0, 'The browser test did not persist encrypted workspace records');
        await page.evaluate(backend => storageConsumer.wrong(backend), backend);
        await page.evaluate(backend => storageConsumer.missing(backend), backend);
        const denied = await page.evaluate(() => persistenceObserver.scan());
        assert.deepEqual(denied.leaks, [], 'A failed key open exposed private metadata');
        assert.equal(denied.encryptedBlocks, first.encryptedBlocks, 'Failed key opens replaced or created protected blocks');
        await page.reload();
        await page.waitForFunction(() => !!globalThis.storageConsumer);
        const reopened = await page.evaluate(({ backend, bytes, markers, saved }) => storageConsumer.reopen(backend, bytes, markers, saved), { backend, bytes, markers, saved });
        await page.evaluate(markers => storageConsumer.explicitMemory(markers), markers);
        const final = await page.evaluate(() => persistenceObserver.scan());
        assert.deepEqual(final.leaks, [], 'Reloaded persistence exposed private metadata');
        assert(final.encryptedBlocks > 0, 'Final browser backing is empty');
        assert.deepEqual(errors, [], 'The standalone consumer produced browser errors');
        report({ runtime: 'browser', backend, browser: browser.version(), policies, first, final, ...reopened, plaintextLeaks: 0 });
      } finally { await context.close(); }
    }
  }
  process.stdout.write(`${JSON.stringify({ result: 'passed', packedConsumer: true, checks: reports.length })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  await rm(temporary, { recursive: true, force: true });
}
