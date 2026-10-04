/** One hostDir pod per child process: ZenFS mount/cache state is never shared. */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createZenFsPod } from './realize/zenfs.js';
import { SnapshotManager } from './oci/snapshot.js';
import { OciStore, newSuperblock } from './oci/store.js';
import { createNativeWorkspaceFs as nativeWorkspace } from './oci/node-workspace.js';
import { assertSafeCheckpointMetadata } from './checkpoint-workspace.js';

interface Operation {
  operation: 'open' | 'create' | 'restore' | 'fork' | 'exec';
  workspacePath: string;
  rootId?: string;
  checkpointId?: string;
  label?: string;
  destination?: string;
  destinationRootId?: string;
  destinationIdentity?: { dev: number; ino: number };
  command?: string;
}

process.once('message', async (message: Operation) => {
  let pod;
  try {
    await assertSafeCheckpointMetadata(message.workspacePath);
    const superblockFile = path.join(message.workspacePath, '.artipod/superblock.json');
    const existing = await fs.readFile(superblockFile, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (existing) {
      const sb = JSON.parse(existing);
      if (sb.formatVersion !== 1 || !/^[a-f0-9]{16}$/.test(sb.podId) || sb.cipher !== 'none') throw new Error('Workspace checkpoints require a valid unencrypted local Artipod');
      if (message.rootId && message.rootId !== sb.podId) throw new Error('Artipod workspace root binding does not match');
    } else if (message.rootId) {
      await fs.mkdir(path.dirname(superblockFile), { recursive: true });
      await fs.writeFile(superblockFile, JSON.stringify(newSuperblock(message.rootId)), { flag: 'wx' });
    }
    pod = await createZenFsPod({ mounts: [{ name: 'work', path: '/', mode: 'rw', source: { kind: 'hostDir', dir: message.workspacePath } }] }, { proc: false, cwd: '/' });
    const rootId = pod.oci.store.getSuperblock().podId;
    const snapshots = new SnapshotManager({ zfs: pod.zfs, store: pod.oci.store, roots: ['/'], defaultExcludes: false, workspaceFs: nativeWorkspace(message.workspacePath) });
    let result: unknown;
    switch (message.operation) {
      case 'open': result = { rootId }; break;
      case 'create': {
        const snapshot = (await snapshots.create({ label: message.label, origin: 'agent-turn' }))!;
        result = { rootId, checkpointId: snapshot.id, ...(message.label === undefined ? {} : { label: message.label }) };
        break;
      }
      case 'restore': {
        const restored = await snapshots.restore(message.checkpointId!);
        result = { rootId, checkpointId: message.checkpointId, changes: restored.changes.map(change => ({ ...change, path: change.path.slice(1) })) };
        break;
      }
      case 'fork': {
        const destination = message.destination!;
        const identity = await fs.lstat(destination);
        if (!identity.isDirectory() || identity.dev !== message.destinationIdentity?.dev || identity.ino !== message.destinationIdentity?.ino || await fs.realpath(destination) !== destination) {
          throw new Error('Artipod fork destination was moved or replaced; refusing to operate');
        }
        const entries = await fs.readdir(destination);
        const metadataEntries = await fs.readdir(path.join(destination, '.artipod'));
        if (entries.length !== 1 || entries[0] !== '.artipod' || metadataEntries.length !== 1 || metadataEntries[0] !== 'checkpoint-lock') {
          throw new Error('Artipod fork destination is no longer empty');
        }
        await assertSafeCheckpointMetadata(destination);
        const targetFs = nativeWorkspace(destination);
        if (message.destinationRootId) {
          await fs.writeFile(path.join(destination, '.artipod/superblock.json'), JSON.stringify(newSuperblock(message.destinationRootId)), { flag: 'wx' });
        }
        const targetStore = new OciStore(targetFs);
        const targetSuperblock = await targetStore.init();
        const targetSnapshots = new SnapshotManager({ zfs: targetFs, store: targetStore, roots: ['/'], defaultExcludes: false });
        await snapshots.copyTo(message.checkpointId!, targetSnapshots);
        await targetSnapshots.restore(message.checkpointId!);
        result = { rootId: targetSuperblock.podId };
        break;
      }
      case 'exec': {
        const sandbox = pod.createSandbox();
        try { result = await sandbox.exec(message.command!); }
        finally { sandbox.dispose(); }
        break;
      }
    }
    pod.dispose();
    process.send?.({ result });
  } catch (error) {
    try { pod?.dispose(); } catch { /* report original failure */ }
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    process.disconnect?.();
  }
});
