#!/usr/bin/env node
/**
 * kerebron prep (predev/prebuild):
 * 1. Copy @kerebron/wasm assets to public/kerebron-wasm — the path
 *    @mieweb/ui's kerebron entry loads grammars/wasm from at runtime.
 * 2. Fix @kerebron css packaging: assets use extensionless SIBLING imports
 *    (`@import 'vars.css'`) that Vite resolves relative-first but
 *    postcss/tailwind treat as package requests. Rewrite to './…' in the
 *    installed copy (idempotent; upstream PR candidate).
 * 3. Fix @kerebron/extension-menu 0.8.12 CustomMenuPlugin: overflow/pinned
 *    dropdown items build synthetic MouseEvents with
 *    `view: dntShim.dntGlobalThis` — a dnt merge Proxy that Chrome refuses
 *    to convert to a Window, so the constructor throws and toolbar items in
 *    "More tools" / pinned dropdowns (e.g. Heading 1) silently do nothing.
 *    Rewrite to `view: window` (idempotent; upstream PR candidate).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
const src = join(root, 'node_modules/@kerebron/wasm/assets');
const dest = join(root, 'public/kerebron-wasm');

if (!existsSync(src)) {
  console.error(`wasm-assets: ${src} missing — is @kerebron/wasm installed?`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

let fixed = 0;
const kerebronRoot = join(root, 'node_modules/@kerebron');
for (const pkg of existsSync(kerebronRoot) ? readdirSync(kerebronRoot) : []) {
  const assets = join(kerebronRoot, pkg, 'assets');
  if (!existsSync(assets)) continue;
  for (const file of readdirSync(assets).filter((f) => f.endsWith('.css'))) {
    const path = join(assets, file);
    const before = readFileSync(path, 'utf8');
    // only sibling files that actually exist become relative
    const after = before.replace(/@import\s+'([A-Za-z0-9][^'/]*\.css)'/g, (m, name) =>
      existsSync(join(assets, name)) ? `@import './${name}'` : m,
    );
    if (after !== before) {
      writeFileSync(path, after);
      fixed += 1;
    }
  }
}

let menuFixed = 0;
const menuPlugin = join(kerebronRoot, 'extension-menu/esm/CustomMenuPlugin.js');
if (existsSync(menuPlugin)) {
  const before = readFileSync(menuPlugin, 'utf8');
  const after = before.replaceAll('view: dntShim.dntGlobalThis', 'view: window');
  if (after !== before) {
    writeFileSync(menuPlugin, after);
    menuFixed = 1;
  }
}

console.log(
  `kerebron wasm assets → public/kerebron-wasm${fixed ? ` · ${fixed} css import fix(es)` : ''}${menuFixed ? ' · menu MouseEvent view fix' : ''}`,
);
