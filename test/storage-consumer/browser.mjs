import { createBrowserVaultAdapters } from '@artipod/core/storage';
import { importBlobKey, isEncryptedBlob } from '@artipod/core/oci';
import { Buffer } from 'buffer';
import { markersFor, writeScenario, reopenScenario, rejectWrongKey, rejectMissingKey, rejectUnsafePolicies, explicitMemory } from './scenario.mjs';

// just-bash's zcat formats byte output through the conventional Buffer API.
globalThis.Buffer ??= Buffer;
globalThis.storageConsumer = {
  markersFor, isEncryptedBlob, rejectUnsafePolicies, explicitMemory,
  async write(backend, bytes, markers) {
    const key = await importBlobKey(new Uint8Array(bytes));
    if (key.extractable) throw new Error('Fixture key must be nonextractable');
    return writeScenario(await createBrowserVaultAdapters(backend), key, markers);
  },
  async reopen(backend, bytes, markers, saved) {
    return reopenScenario(await createBrowserVaultAdapters(backend), await importBlobKey(new Uint8Array(bytes)), markers, saved);
  },
  async wrong(backend) { return rejectWrongKey(await createBrowserVaultAdapters(backend)); },
  async missing(backend) { return rejectMissingKey(await createBrowserVaultAdapters(backend)); },
};
