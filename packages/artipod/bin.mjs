#!/usr/bin/env node
// `npx artipod` sugar: run @artipod/core's CLI in-process. The file-URL import
// sidesteps core's exports map, which doesn't expose ./dist/cli.js as a subpath.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const pkgJsonPath = require.resolve('@artipod/core/package.json');
const { bin } = require(pkgJsonPath);
await import(pathToFileURL(join(dirname(pkgJsonPath), bin.artipod)).href);
