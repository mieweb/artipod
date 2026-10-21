/** Shared Node/browser exercise. Every library import is a published entry. */
import { createZenFsPod } from '@artipod/core';
import { createStorageSession } from '@artipod/core/storage';
import { generateBlobKey } from '@artipod/core/oci';

const check = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)}`);
const manifest = { formatVersion: 1, mounts: [{ name: 'workspace', path: '/workspace', mode: 'rw', source: { kind: 'backend', backend: 'memory' } }] };

export const markersFor = id => ({
  directory: `private-directory-${id}`,
  filename: `private-filename-${id}.txt`,
  payload: `private-payload-${id}`,
  target: `private-link-target-${id}.txt`,
  link: `private-link-${id}`,
  label: `private-snapshot-label-${id}`,
  ref: `private-ref-${id}:1`,
  metadata: `private-metadata-${id}`,
});

export function injectedKeys(initial) {
  let current = initial;
  return {
    getKey: () => current,
    requireKey() { if (!current) throw new Error('Test key lease is released'); return current; },
    storagePolicy: 'encrypted',
    async suspendForReset() { return () => {}; },
    setKey(key) { current = key; },
  };
}

export async function rejectUnsafePolicies() {
  const calls = [];
  const raw = { promises: new Proxy({}, { get: (_, name) => () => { calls.push(String(name)); throw new Error('Unexpected initialization write'); } }) };
  const forged = { zfs: raw, protection: 'encrypted', encrypted: true, memoryOnly: false, backend: 'native', flush: async () => {}, assertAccess() {} };
  for (const options of [{ storage: forged, storagePolicy: 'protected' }, { adopt: raw, storagePolicy: 'protected' }]) {
    let failure;
    try { await createZenFsPod(manifest, options); } catch (error) { failure = error; }
    check(failure, 'Protected creation accepted an untrusted filesystem');
    check(/storage context/i.test(failure.message), `Unexpected policy rejection: ${failure.message}`);
  }
  equal(calls, [], 'Policy rejection must happen before initialization I/O');
  return { rejected: 2, initializationCalls: calls.length };
}

export async function writeScenario(adapters, key, markers) {
  const provider = injectedKeys(key);
  const session = createStorageSession({ keys: provider, adapters });
  const storage = await session.open();
  equal(storage.protection, 'encrypted', 'Protected session must be encrypted');
  const pod = await createZenFsPod(manifest, { storage, storagePolicy: 'protected', proc: false });
  const p = storage.zfs.promises;
  const directory = `/workspace/${markers.directory}`;
  await p.mkdir(directory, { recursive: true });
  await p.writeFile(`${directory}/${markers.filename}`, markers.payload);
  await p.writeFile(`${directory}/${markers.target}`, 'symlink target contents');
  await p.symlink(markers.target, `${directory}/${markers.link}`);
  await p.writeFile('/.artipod/private-metadata.json', JSON.stringify({ workspace: markers.metadata, reference: markers.ref }));
  const shell = pod.createSandbox();
  try {
    const zipped = await shell.exec(`gzip -k '${directory}/${markers.filename}'`);
    equal(zipped.exitCode, 0, `Shell gzip failed: ${zipped.stderr}`);
    const unzipped = await shell.exec(`zcat '${directory}/${markers.filename}.gz'`);
    equal(unzipped.exitCode, 0, `Shell zcat failed: ${unzipped.stderr}`);
    equal(unzipped.stdout, markers.payload, 'Browser gzip adapter round trip');
    await p.unlink(`${directory}/${markers.filename}.gz`);
  } finally { shell.dispose(); }
  const snapshot = await pod.snapshots.create({ label: markers.label });
  check(snapshot, 'Snapshot creation returned no snapshot');
  const committed = await pod.snapshots.commit(markers.ref);
  check(committed.manifestDigest.startsWith('sha256:'), 'Commit did not create a manifest');
  await p.writeFile(`${directory}/${markers.filename}`, 'changed after checkpoint');
  await p.writeFile(`${directory}/later.txt`, 'remove when restoring');
  await pod.snapshots.restore(snapshot.id);
  equal(await p.readFile(`${directory}/${markers.filename}`, 'utf8'), markers.payload, 'Restore must recover exact payload');
  check(!(await p.exists(`${directory}/later.txt`)), 'Restore must remove later files');
  await session.flush();
  const saved = { generation: storage.generation, snapshot: snapshot.id, manifest: committed.manifestDigest, backend: storage.backend };
  pod.dispose();
  await session.close();
  let stale;
  try { await storage.zfs.promises.readFile(`${directory}/${markers.filename}`, 'utf8'); } catch (error) { stale = error; }
  check(stale, 'Closed context still allowed cached filesystem access');
  return saved;
}

export async function reopenScenario(adapters, key, markers, saved) {
  const provider = injectedKeys(key);
  const session = createStorageSession({ keys: provider, adapters });
  const storage = await session.open();
  equal(storage.generation, saved.generation, 'Reopen must retain the saved generation');
  const pod = await createZenFsPod(manifest, { storage, storagePolicy: 'protected', proc: false });
  const p = storage.zfs.promises;
  const directory = `/workspace/${markers.directory}`;
  equal(await p.readFile(`${directory}/${markers.filename}`, 'utf8'), markers.payload, 'Reopen payload');
  equal(await p.readlink(`${directory}/${markers.link}`), markers.target, 'Reopen symlink target');
  equal(JSON.parse(await p.readFile('/.artipod/private-metadata.json', 'utf8')), { workspace: markers.metadata, reference: markers.ref }, 'Reopen private metadata');
  const snapshots = await pod.snapshots.list();
  check(snapshots.some(snapshot => snapshot.id === saved.snapshot && snapshot.label === markers.label), 'Snapshot label or identity was lost');
  const ref = await pod.oci.store.getRef(markers.ref);
  equal(ref?.manifestDigest, saved.manifest, 'Ref must recover its exact manifest');
  const manifestBytes = await pod.oci.store.getBlob(saved.manifest);
  const image = JSON.parse(new TextDecoder().decode(manifestBytes));
  check(image.layers.length > 0, 'Committed image has no layer');
  const layerIndexDigest = image.layers[0].annotations?.['org.artipod.layer-index'];
  check(layerIndexDigest, 'Committed layer did not publish a filename index');
  const layerIndex = JSON.parse(new TextDecoder().decode(await pod.oci.store.getBlob(layerIndexDigest)));
  check(JSON.stringify(layerIndex).includes(markers.filename), 'Filename metadata was lost from the persisted layer index');
  provider.setKey(null);
  let locked;
  try { await p.readFile(`${directory}/${markers.filename}`, 'utf8'); } catch (error) { locked = error; }
  check(locked, 'Lease release allowed cached reads');
  pod.dispose();
  try { await session.close(); } catch { /* Close must still release ownership after revoked access. */ }
  return { files: 3, snapshots: snapshots.length, refs: 1, releasedCachedRead: true };
}

export async function rejectWrongKey(adapters) {
  const wrong = await generateBlobKey();
  const session = createStorageSession({ adapters, keys: injectedKeys(wrong) });
  let failure;
  try { await session.open(); } catch (error) { failure = error; }
  check(failure, 'Saved encrypted storage accepted a wrong key');
  await session.close().catch(() => {});
  return true;
}

export async function rejectMissingKey(adapters) {
  const session = createStorageSession({ adapters, keys: injectedKeys(null) });
  let failure;
  try { await session.open(); } catch (error) { failure = error; }
  check(failure, 'Protected persistence accepted a missing key');
  await session.close().catch(() => {});
  return true;
}

export async function explicitMemory(markers = { filename: 'volatile.txt', payload: 'memory contents' }) {
  const session = createStorageSession({ policy: 'memory' });
  const storage = await session.open();
  equal(storage.protection, 'volatile', 'Explicit memory policy must report volatile protection');
  const pod = await createZenFsPod(manifest, { storage, storagePolicy: 'protected', proc: false });
  const confined = pod.createSandbox({ confineTo: '/workspace' });
  const path = `/workspace/${markers.filename}`;
  await storage.zfs.promises.writeFile(path, markers.payload);
  await session.close();
  const fresh = createStorageSession({ policy: 'memory' });
  const next = await fresh.open();
  const nextPod = await createZenFsPod(manifest, { storage: next, storagePolicy: 'protected', proc: false });
  const nextShell = nextPod.createSandbox({ confineTo: '/workspace' });
  check(!(await next.zfs.promises.exists(path)), 'Memory contents survived a new session');
  const replacement = `${markers.payload}-replacement-root`;
  await next.zfs.promises.writeFile(path, replacement);
  equal((await nextShell.exec(`cat '/${markers.filename}'`)).stdout, replacement, 'Fresh confined shell must read its current root');
  const stale = await confined.exec(`cat '/${markers.filename}'`).catch(error => ({ exitCode: 1, stdout: '', stderr: String(error) }));
  check(stale.exitCode !== 0 && !stale.stdout.includes(replacement), 'Stale confined shell accessed the replacement root');
  confined.dispose();
  nextShell.dispose();
  pod.dispose();
  nextPod.dispose();
  await fresh.close();
  return true;
}
