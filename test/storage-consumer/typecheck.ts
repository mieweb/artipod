import { createZenFsPod, type PodManifest } from '@artipod/core';
import { createStorageSession, readStorageTextFile, writeStorageTextFile, type StorageContext, type StorageKeyProvider } from '@artipod/core/storage';
import { createNativeStorageAdapters } from '@artipod/core/storage/node';
import { generateBlobKey } from '@artipod/core/oci';

async function consumer(directory: string, manifest: PodManifest) {
  const key = await generateBlobKey();
  const keys: StorageKeyProvider = { getKey: () => key, requireKey: () => key, storagePolicy: 'encrypted', suspendForReset: async () => () => {} };
  const session = createStorageSession({ keys, adapters: await createNativeStorageAdapters(directory) });
  const storage: StorageContext = await session.open();
  const pod = await createZenFsPod(manifest, { storage, storagePolicy: 'protected' });
  const textFile = { zfs: storage.zfs, path: '/.artipod/consumer.json', previousPath: '/.artipod/.consumer.previous' };
  await writeStorageTextFile(textFile, '{"saved":true}');
  const saved: string | null = await readStorageTextFile(textFile);
  void saved;
  await session.flush();
  pod.dispose();
  await session.close();
}
void consumer;
