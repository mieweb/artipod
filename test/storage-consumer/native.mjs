import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createNativeStorageAdapters } from '@artipod/core/storage/node';
import { generateBlobKey, isEncryptedBlob } from '@artipod/core/oci';
import { markersFor, writeScenario, reopenScenario, rejectWrongKey, rejectMissingKey, rejectUnsafePolicies, explicitMemory } from './scenario.mjs';

const directory = await mkdtemp(join(tmpdir(), 'artipod-native-consumer-'));
const markers = markersFor(randomUUID());
const history = [];
const variants = marker => [marker, encodeURIComponent(marker), encodeURIComponent(encodeURIComponent(marker)), JSON.stringify(marker).slice(1, -1), Buffer.from(marker).toString('base64'), Buffer.from(marker).toString('hex'), [...marker].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')];
const inspect = (path, bytes) => {
  const value = `${path}\n${new TextDecoder().decode(bytes)}\n${new TextDecoder('utf-16le').decode(bytes)}`;
  for (const marker of Object.values(markers)) for (const form of variants(marker)) assert(!value.includes(form), `Private marker reached native backing: ${path}`);
};
const adapters = () => createNativeStorageAdapters(directory, { onWrite(path, bytes) { inspect(path, bytes); history.push({ path: relative(directory, path), bytes: bytes.slice() }); } });
async function scan() {
  let blocks = 0;
  async function walk(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const location = join(path, entry.name);
      inspect(relative(directory, location), new Uint8Array());
      if (entry.isDirectory()) await walk(location);
      else {
        const bytes = new Uint8Array(await readFile(location));
        inspect(relative(directory, location), bytes);
        if (location.includes('/generations/')) {
          assert.match(entry.name, /^\d+$/, 'Native backing exposed a logical filename');
          assert(isEncryptedBlob(bytes), 'Native generation record is not ciphertext');
          blocks++;
        }
      }
    }
  }
  await walk(directory);
  assert(blocks > 0, 'Raw scan found no persistent blocks');
  return blocks;
}

try {
  const policies = await rejectUnsafePolicies();
  const key = await generateBlobKey();
  assert.equal(key.extractable, false);
  const saved = await writeScenario(await adapters(), key, markers);
  const firstBlocks = await scan();
  const before = await readFile(join(directory, 'control.json'), 'utf8');
  await rejectWrongKey(await adapters());
  await rejectMissingKey(await adapters());
  assert.equal(await readFile(join(directory, 'control.json'), 'utf8'), before, 'Wrong key replaced the saved control');
  assert.deepEqual(await readdir(join(directory, 'generations')), [saved.generation], 'Wrong key created a replacement generation');
  const reopened = await reopenScenario(await adapters(), key, markers, saved);
  const finalBlocks = await scan();
  const blockWrites = history.filter(write => write.path.startsWith('generations/'));
  assert(blockWrites.length > 0, 'The native write observer saw no block writes');
  assert(blockWrites.every(write => isEncryptedBlob(write.bytes)), 'A first write reached native storage before encryption');
  await explicitMemory(markers);
  process.stdout.write(`${JSON.stringify({ result: 'passed', runtime: 'node', policies, firstBlocks, finalBlocks, firstWrites: history.length, ...reopened, plaintextLeaks: 0 })}\n`);
} finally { await rm(directory, { recursive: true, force: true }); }
