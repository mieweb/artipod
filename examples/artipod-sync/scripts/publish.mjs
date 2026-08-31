#!/usr/bin/env node
/**
 * Publish a server folder into this deployment's pod store:
 *   npm run publish:folder -- <dir> <ref>
 * e.g.
 *   npm run publish:folder -- ../../docs folder/docs:latest
 * Store dir: ARTIPOD_STORE_DIR (default .artipod-store — same as the app).
 */
import { nodePodFs } from '@artipod/core';
import { OciLayoutPodStore } from '@artipod/core/manager';
import { publishDirectory } from '@artipod/core/server';

const [dir, ref] = process.argv.slice(2);
if (!dir || !ref) {
  console.error('usage: node scripts/publish.mjs <dir> <ref[:tag]>');
  process.exit(2);
}

const store = new OciLayoutPodStore(nodePodFs(), process.env.ARTIPOD_STORE_DIR ?? '.artipod-store');
await store.init();
const result = await publishDirectory(store, dir, ref);
for (const w of result.warnings) console.warn(`warn: ${w}`);
console.log(
  result.unchanged
    ? `unchanged — ${ref} stays at ${result.manifestDigest}`
    : `published ${ref}: ${result.layers} layers (${result.reusedLayers} reused, ${result.bytes} new bytes) → ${result.manifestDigest}`,
);
