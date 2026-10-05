# Runtime sources and rebuilding

The extension source is https://github.com/mieweb/artipod/tree/artipod/vscode-extension. The Artipod backend source is https://github.com/mieweb/artipod/tree/artipod/src.

## Replaceable libraries

`@zenfs/core`, `@zenfs/dom`, `utilium`, and `memium` retain their LGPL licenses. Their JavaScript is shipped as separate modules under `vendor/node_modules`, with the exact nested dependency versions from the root package-lock.json. They are not statically included in the worker bundles. You may inspect, modify, or replace those modules with interface-compatible versions in an unpacked VSIX and reload VS Code; no integrity check prevents replacement. Keep nested dependencies compatible. This distribution imposes no restriction on modification or reverse engineering for debugging changes to those libraries.

## ZenFS compatibility modification

Artipod changes @zenfs/core 2.4.4 dist/index.js on 2026-10-04. Electron Node 24.21 rejects Object.assign when its target inherits from an ESM module namespace. The change uses Object.defineProperty to define an own _version property while preserving the filesystem namespace prototype and writable/enumerable/configurable property behavior. The upstream npm package remains untouched in the source checkout; only the copied VSIX library is modified.

The exact unified source patch is included at `vendor/patches/zenfs-core-2.4.4-module-version.patch`. Its reproducible patch specification is `scripts/patches/zenfs-core-2.4.4-module-version.json` in the extension source repository. Packaging checks the exact package version and original statement, and stops if either changes. The modified source retains its LGPL-3.0-or-later license and has a dated modification notice. Other copied libraries are unmodified.

## Rebuild the extension

Use Node.js 22 or later and the repository commit supplied with the release. From the repository root:

```sh
npm ci
npm run build
cd vscode-extension
npm ci
npm test
npm run package:vsix
```

The checked-in lockfiles pin the application and packaging dependencies. `prepare-backend` regenerates worker bundles, copies the replaceable library tree, applies the checked ZenFS compatibility patch, and writes these notices. `package:vsix` builds and packages only; it does not publish. Output is `dist/artipod-0.1.0.vsix`.

To rebuild against a modified library source, build that library using its upstream instructions, replace its installed package in the Artipod repository node_modules tree, then rerun `npm run prepare-backend` in vscode-extension. Then run `npm run package:vsix`; this rebuilds against the installed dependency tree and does not reinstall or replace your modified library.

## Exact npm package archives

These archives identify the versions included or whose notices accompany the prebundled shell. Upstream repositories contain development source and build instructions. The npm archives contain the JavaScript modules shipped by each package.

| Package | License | Repository | Versioned archive |
| --- | --- | --- | --- |
| @borewit/text-codec@0.2.2 | MIT | [source](https://github.com/Borewit/text-codec) | [archive](https://registry.npmjs.org/@borewit/text-codec/-/text-codec-0.2.2.tgz) |
| @jitl/quickjs-ffi-types@0.32.0 | MIT | [source](https://github.com/justjake/quickjs-emscripten) | [archive](https://registry.npmjs.org/@jitl/quickjs-ffi-types/-/quickjs-ffi-types-0.32.0.tgz) |
| @jitl/quickjs-wasmfile-debug-asyncify@0.32.0 | MIT | [source](https://github.com/justjake/quickjs-emscripten) | [archive](https://registry.npmjs.org/@jitl/quickjs-wasmfile-debug-asyncify/-/quickjs-wasmfile-debug-asyncify-0.32.0.tgz) |
| @jitl/quickjs-wasmfile-debug-sync@0.32.0 | MIT | [source](https://github.com/justjake/quickjs-emscripten) | [archive](https://registry.npmjs.org/@jitl/quickjs-wasmfile-debug-sync/-/quickjs-wasmfile-debug-sync-0.32.0.tgz) |
| @jitl/quickjs-wasmfile-release-asyncify@0.32.0 | MIT | [source](https://github.com/justjake/quickjs-emscripten) | [archive](https://registry.npmjs.org/@jitl/quickjs-wasmfile-release-asyncify/-/quickjs-wasmfile-release-asyncify-0.32.0.tgz) |
| @jitl/quickjs-wasmfile-release-sync@0.32.0 | MIT | [source](https://github.com/justjake/quickjs-emscripten) | [archive](https://registry.npmjs.org/@jitl/quickjs-wasmfile-release-sync/-/quickjs-wasmfile-release-sync-0.32.0.tgz) |
| @mixmark-io/domino@2.2.0 | BSD-2-Clause | [source](https://github.com/mixmark-io/domino) | [archive](https://registry.npmjs.org/@mixmark-io/domino/-/domino-2.2.0.tgz) |
| @nodable/entities@3.0.0 | MIT | [source](https://github.com/nodable/val-parsers) | [archive](https://registry.npmjs.org/@nodable/entities/-/entities-3.0.0.tgz) |
| @tokenizer/inflate@0.4.1 | MIT | [source](https://github.com/Borewit/tokenizer-inflate) | [archive](https://registry.npmjs.org/@tokenizer/inflate/-/inflate-0.4.1.tgz) |
| @tokenizer/token@0.3.0 | MIT | [source](https://github.com/Borewit/tokenizer-token) | [archive](https://registry.npmjs.org/@tokenizer/token/-/token-0.3.0.tgz) |
| @types/node@24.13.3 | MIT | [source](https://github.com/DefinitelyTyped/DefinitelyTyped) | [archive](https://registry.npmjs.org/@types/node/-/node-24.13.3.tgz) |
| @zenfs/core@2.4.4 | LGPL-3.0-or-later | [source](https://github.com/zen-fs/core) | [archive](https://registry.npmjs.org/@zenfs/core/-/core-2.4.4.tgz) |
| @zenfs/dom@1.2.5 | LGPL-3.0-or-later | [source](https://github.com/zen-fs/dom) | [archive](https://registry.npmjs.org/@zenfs/dom/-/dom-1.2.5.tgz) |
| abort-controller@3.0.0 | MIT | [source](https://github.com/mysticatea/abort-controller) | [archive](https://registry.npmjs.org/abort-controller/-/abort-controller-3.0.0.tgz) |
| anynum@1.0.1 | MIT | [source](https://github.com/NaturalIntelligence/anynum) | [archive](https://registry.npmjs.org/anynum/-/anynum-1.0.1.tgz) |
| async-lock@1.4.1 | MIT | [source](https://github.com/rogierschouten/async-lock) | [archive](https://registry.npmjs.org/async-lock/-/async-lock-1.4.1.tgz) |
| available-typed-arrays@1.0.7 | MIT | [source](https://github.com/inspect-js/available-typed-arrays) | [archive](https://registry.npmjs.org/available-typed-arrays/-/available-typed-arrays-1.0.7.tgz) |
| balanced-match@4.0.4 | MIT | [source](https://github.com/juliangruber/balanced-match) | [archive](https://registry.npmjs.org/balanced-match/-/balanced-match-4.0.4.tgz) |
| base64-js@1.5.1 | MIT | [source](https://github.com/beatgammit/base64-js) | [archive](https://registry.npmjs.org/base64-js/-/base64-js-1.5.1.tgz) |
| brace-expansion@5.0.9 | MIT | [source](https://github.com/juliangruber/brace-expansion) | [archive](https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz) |
| buffer@6.0.3 | MIT | [source](https://github.com/feross/buffer) | [archive](https://registry.npmjs.org/buffer/-/buffer-6.0.3.tgz) |
| call-bind@1.0.9 | MIT | [source](https://github.com/ljharb/call-bind) | [archive](https://registry.npmjs.org/call-bind/-/call-bind-1.0.9.tgz) |
| call-bind-apply-helpers@1.0.2 | MIT | [source](https://github.com/ljharb/call-bind-apply-helpers) | [archive](https://registry.npmjs.org/call-bind-apply-helpers/-/call-bind-apply-helpers-1.0.2.tgz) |
| call-bound@1.0.4 | MIT | [source](https://github.com/ljharb/call-bound) | [archive](https://registry.npmjs.org/call-bound/-/call-bound-1.0.4.tgz) |
| clean-git-ref@2.0.1 | Apache-2.0 | [source](https://github.com/TheSavior/clean-git-ref) | [archive](https://registry.npmjs.org/clean-git-ref/-/clean-git-ref-2.0.1.tgz) |
| commander@6.2.1 | MIT | [source](https://github.com/tj/commander.js) | [archive](https://registry.npmjs.org/commander/-/commander-6.2.1.tgz) |
| crc-32@1.2.2 | Apache-2.0 | [source](https://github.com/SheetJS/js-crc32) | [archive](https://registry.npmjs.org/crc-32/-/crc-32-1.2.2.tgz) |
| debug@4.4.3 | MIT | [source](https://github.com/debug-js/debug) | [archive](https://registry.npmjs.org/debug/-/debug-4.4.3.tgz) |
| define-data-property@1.1.4 | MIT | [source](https://github.com/ljharb/define-data-property) | [archive](https://registry.npmjs.org/define-data-property/-/define-data-property-1.1.4.tgz) |
| diff@8.0.4 | BSD-3-Clause | [source](https://github.com/kpdecker/jsdiff) | [archive](https://registry.npmjs.org/diff/-/diff-8.0.4.tgz) |
| diff3@0.0.3 | MIT | [source](https://github.com/axosoft/diff3) | [archive](https://registry.npmjs.org/diff3/-/diff3-0.0.3.tgz) |
| dunder-proto@1.0.1 | MIT | [source](https://github.com/es-shims/dunder-proto) | [archive](https://registry.npmjs.org/dunder-proto/-/dunder-proto-1.0.1.tgz) |
| es-define-property@1.0.1 | MIT | [source](https://github.com/ljharb/es-define-property) | [archive](https://registry.npmjs.org/es-define-property/-/es-define-property-1.0.1.tgz) |
| es-errors@1.3.0 | MIT | [source](https://github.com/ljharb/es-errors) | [archive](https://registry.npmjs.org/es-errors/-/es-errors-1.3.0.tgz) |
| es-object-atoms@1.1.2 | MIT | [source](https://github.com/ljharb/es-object-atoms) | [archive](https://registry.npmjs.org/es-object-atoms/-/es-object-atoms-1.1.2.tgz) |
| event-target-shim@5.0.1 | MIT | [source](https://github.com/mysticatea/event-target-shim) | [archive](https://registry.npmjs.org/event-target-shim/-/event-target-shim-5.0.1.tgz) |
| eventemitter3@5.0.4 | MIT | [source](https://github.com/primus/eventemitter3) | [archive](https://registry.npmjs.org/eventemitter3/-/eventemitter3-5.0.4.tgz) |
| events@3.3.0 | MIT | [source](https://github.com/Gozala/events) | [archive](https://registry.npmjs.org/events/-/events-3.3.0.tgz) |
| fast-xml-builder@1.3.1 | MIT | [source](https://github.com/NaturalIntelligence/fast-xml-builder) | [archive](https://registry.npmjs.org/fast-xml-builder/-/fast-xml-builder-1.3.1.tgz) |
| fast-xml-parser@5.11.1 | MIT | [source](https://github.com/NaturalIntelligence/fast-xml-parser) | [archive](https://registry.npmjs.org/fast-xml-parser/-/fast-xml-parser-5.11.1.tgz) |
| fflate@0.8.3 | MIT | [source](https://github.com/101arrowz/fflate) | [archive](https://registry.npmjs.org/fflate/-/fflate-0.8.3.tgz) |
| file-type@21.3.4 | MIT | [source](https://github.com/sindresorhus/file-type) | [archive](https://registry.npmjs.org/file-type/-/file-type-21.3.4.tgz) |
| for-each@0.3.5 | MIT | [source](https://github.com/Raynos/for-each) | [archive](https://registry.npmjs.org/for-each/-/for-each-0.3.5.tgz) |
| function-bind@1.1.2 | MIT | [source](https://github.com/Raynos/function-bind) | [archive](https://registry.npmjs.org/function-bind/-/function-bind-1.1.2.tgz) |
| get-intrinsic@1.3.0 | MIT | [source](https://github.com/ljharb/get-intrinsic) | [archive](https://registry.npmjs.org/get-intrinsic/-/get-intrinsic-1.3.0.tgz) |
| get-proto@1.0.1 | MIT | [source](https://github.com/ljharb/get-proto) | [archive](https://registry.npmjs.org/get-proto/-/get-proto-1.0.1.tgz) |
| gopd@1.2.0 | MIT | [source](https://github.com/ljharb/gopd) | [archive](https://registry.npmjs.org/gopd/-/gopd-1.2.0.tgz) |
| has-property-descriptors@1.0.2 | MIT | [source](https://github.com/inspect-js/has-property-descriptors) | [archive](https://registry.npmjs.org/has-property-descriptors/-/has-property-descriptors-1.0.2.tgz) |
| has-symbols@1.1.0 | MIT | [source](https://github.com/inspect-js/has-symbols) | [archive](https://registry.npmjs.org/has-symbols/-/has-symbols-1.1.0.tgz) |
| has-tostringtag@1.0.2 | MIT | [source](https://github.com/inspect-js/has-tostringtag) | [archive](https://registry.npmjs.org/has-tostringtag/-/has-tostringtag-1.0.2.tgz) |
| hasown@2.0.4 | MIT | [source](https://github.com/inspect-js/hasOwn) | [archive](https://registry.npmjs.org/hasown/-/hasown-2.0.4.tgz) |
| ieee754@1.2.1 | BSD-3-Clause | [source](https://github.com/feross/ieee754) | [archive](https://registry.npmjs.org/ieee754/-/ieee754-1.2.1.tgz) |
| ignore@5.3.2 | MIT | [source](https://github.com/kaelzhang/node-ignore) | [archive](https://registry.npmjs.org/ignore/-/ignore-5.3.2.tgz) |
| inherits@2.0.4 | ISC | [source](https://github.com/isaacs/inherits) | [archive](https://registry.npmjs.org/inherits/-/inherits-2.0.4.tgz) |
| ini@6.0.0 | ISC | [source](https://github.com/npm/ini) | [archive](https://registry.npmjs.org/ini/-/ini-6.0.0.tgz) |
| is-callable@1.2.7 | MIT | [source](https://github.com/inspect-js/is-callable) | [archive](https://registry.npmjs.org/is-callable/-/is-callable-1.2.7.tgz) |
| is-typed-array@1.1.15 | MIT | [source](https://github.com/inspect-js/is-typed-array) | [archive](https://registry.npmjs.org/is-typed-array/-/is-typed-array-1.1.15.tgz) |
| is-unsafe@2.0.2 | MIT | [source](https://github.com/NaturalIntelligence/is-unsafe) | [archive](https://registry.npmjs.org/is-unsafe/-/is-unsafe-2.0.2.tgz) |
| isarray@2.0.5 | MIT | [source](https://github.com/juliangruber/isarray) | [archive](https://registry.npmjs.org/isarray/-/isarray-2.0.5.tgz) |
| isomorphic-git@1.41.9 | MIT | [source](https://github.com/isomorphic-git/isomorphic-git) | [archive](https://registry.npmjs.org/isomorphic-git/-/isomorphic-git-1.41.9.tgz) |
| just-bash@3.2.0 | Apache-2.0 | [source](https://github.com/vercel-labs/just-bash) | [archive](https://registry.npmjs.org/just-bash/-/just-bash-3.2.0.tgz) |
| kerium@1.4.2 | MIT | [source](https://github.com/james-pre/kerium) | [archive](https://registry.npmjs.org/kerium/-/kerium-1.4.2.tgz) |
| math-intrinsics@1.1.0 | MIT | [source](https://github.com/es-shims/math-intrinsics) | [archive](https://registry.npmjs.org/math-intrinsics/-/math-intrinsics-1.1.0.tgz) |
| memium@0.3.11 | LGPL-3.0-or-later | [source](https://github.com/james-pre/memium) | [archive](https://registry.npmjs.org/memium/-/memium-0.3.11.tgz) |
| minimatch@10.2.6 | BlueOak-1.0.0 | [source](https://github.com/isaacs/minimatch) | [archive](https://registry.npmjs.org/minimatch/-/minimatch-10.2.6.tgz) |
| modern-tar@0.7.7 | MIT | [source](https://github.com/ayuhito/modern-tar) | [archive](https://registry.npmjs.org/modern-tar/-/modern-tar-0.7.7.tgz) |
| ms@2.1.3 | MIT | [source](https://github.com/vercel/ms) | [archive](https://registry.npmjs.org/ms/-/ms-2.1.3.tgz) |
| pako@1.0.11 | (MIT AND Zlib) | [source](https://github.com/nodeca/pako) | [archive](https://registry.npmjs.org/pako/-/pako-1.0.11.tgz) |
| papaparse@5.7.0 | MIT | [source](https://github.com/mholt/PapaParse) | [archive](https://registry.npmjs.org/papaparse/-/papaparse-5.7.0.tgz) |
| path-expression-matcher@1.6.2 | MIT | [source](https://github.com/NaturalIntelligence/path-expression-matcher) | [archive](https://registry.npmjs.org/path-expression-matcher/-/path-expression-matcher-1.6.2.tgz) |
| pify@4.0.1 | MIT | [source](https://github.com/sindresorhus/pify) | [archive](https://registry.npmjs.org/pify/-/pify-4.0.1.tgz) |
| possible-typed-array-names@1.1.0 | MIT | [source](https://github.com/ljharb/possible-typed-array-names) | [archive](https://registry.npmjs.org/possible-typed-array-names/-/possible-typed-array-names-1.1.0.tgz) |
| process@0.11.10 | MIT | [source](https://github.com/shtylman/node-process) | [archive](https://registry.npmjs.org/process/-/process-0.11.10.tgz) |
| quickjs-emscripten@0.32.0 | MIT | [source](https://github.com/justjake/quickjs-emscripten) | [archive](https://registry.npmjs.org/quickjs-emscripten/-/quickjs-emscripten-0.32.0.tgz) |
| quickjs-emscripten-core@0.32.0 | MIT | [source](https://github.com/justjake/quickjs-emscripten) | [archive](https://registry.npmjs.org/quickjs-emscripten-core/-/quickjs-emscripten-core-0.32.0.tgz) |
| re2js@1.3.3 | MIT | [source](https://github.com/le0pard/re2js) | [archive](https://registry.npmjs.org/re2js/-/re2js-1.3.3.tgz) |
| readable-stream@4.7.0 | MIT | [source](https://github.com/nodejs/readable-stream) | [archive](https://registry.npmjs.org/readable-stream/-/readable-stream-4.7.0.tgz) |
| safe-buffer@5.2.1 | MIT | [source](https://github.com/feross/safe-buffer) | [archive](https://registry.npmjs.org/safe-buffer/-/safe-buffer-5.2.1.tgz) |
| seek-bzip@2.0.0 | MIT | [source](https://github.com/cscott/seek-bzip) | [archive](https://registry.npmjs.org/seek-bzip/-/seek-bzip-2.0.0.tgz) |
| set-function-length@1.2.2 | MIT | [source](https://github.com/ljharb/set-function-length) | [archive](https://registry.npmjs.org/set-function-length/-/set-function-length-1.2.2.tgz) |
| sha.js@2.4.12 | (MIT AND BSD-3-Clause) | [source](https://github.com/crypto-browserify/sha.js) | [archive](https://registry.npmjs.org/sha.js/-/sha.js-2.4.12.tgz) |
| smol-toml@1.8.0 | BSD-3-Clause | [source](https://github.com/squirrelchat/smol-toml) | [archive](https://registry.npmjs.org/smol-toml/-/smol-toml-1.8.0.tgz) |
| sprintf-js@1.1.3 | BSD-3-Clause | [source](https://github.com/alexei/sprintf.js) | [archive](https://registry.npmjs.org/sprintf-js/-/sprintf-js-1.1.3.tgz) |
| sql.js@1.14.2 | MIT | [source](http://github.com/sql-js/sql.js) | [archive](https://registry.npmjs.org/sql.js/-/sql.js-1.14.2.tgz) |
| string_decoder@1.3.0 | MIT | [source](https://github.com/nodejs/string_decoder) | [archive](https://registry.npmjs.org/string_decoder/-/string_decoder-1.3.0.tgz) |
| strnum@2.4.2 | MIT | [source](https://github.com/NaturalIntelligence/strnum) | [archive](https://registry.npmjs.org/strnum/-/strnum-2.4.2.tgz) |
| strtok3@10.3.5 | MIT | [source](https://github.com/Borewit/strtok3) | [archive](https://registry.npmjs.org/strtok3/-/strtok3-10.3.5.tgz) |
| to-buffer@1.2.2 | MIT | [source](https://github.com/browserify/to-buffer) | [archive](https://registry.npmjs.org/to-buffer/-/to-buffer-1.2.2.tgz) |
| token-types@6.1.2 | MIT | [source](https://github.com/Borewit/token-types) | [archive](https://registry.npmjs.org/token-types/-/token-types-6.1.2.tgz) |
| turndown@7.2.4 | MIT | [source](https://github.com/mixmark-io/turndown) | [archive](https://registry.npmjs.org/turndown/-/turndown-7.2.4.tgz) |
| typed-array-buffer@1.0.3 | MIT | [source](https://github.com/inspect-js/typed-array-buffer) | [archive](https://registry.npmjs.org/typed-array-buffer/-/typed-array-buffer-1.0.3.tgz) |
| uint8array-extras@1.5.0 | MIT | [source](https://github.com/sindresorhus/uint8array-extras) | [archive](https://registry.npmjs.org/uint8array-extras/-/uint8array-extras-1.5.0.tgz) |
| undici@7.29.0 | MIT | [source](https://github.com/nodejs/undici) | [archive](https://registry.npmjs.org/undici/-/undici-7.29.0.tgz) |
| undici-types@7.18.2 | MIT | [source](https://github.com/nodejs/undici) | [archive](https://registry.npmjs.org/undici-types/-/undici-types-7.18.2.tgz) |
| utilium@2.8.8 | LGPL-3.0-or-later | [source](https://github.com/james-pre/utilium) | [archive](https://registry.npmjs.org/utilium/-/utilium-2.8.8.tgz) |
| utilium@3.5.1 | LGPL-3.0-or-later | [source](https://github.com/james-pre/utilium) | [archive](https://registry.npmjs.org/utilium/-/utilium-3.5.1.tgz) |
| which-typed-array@1.1.22 | MIT | [source](https://github.com/inspect-js/which-typed-array) | [archive](https://registry.npmjs.org/which-typed-array/-/which-typed-array-1.1.22.tgz) |
| xml-naming@0.3.0 | MIT | [source](https://github.com/NaturalIntelligence/xml-naming) | [archive](https://registry.npmjs.org/xml-naming/-/xml-naming-0.3.0.tgz) |
| yaml@2.9.0 | ISC | [source](https://github.com/eemeli/yaml) | [archive](https://registry.npmjs.org/yaml/-/yaml-2.9.0.tgz) |
