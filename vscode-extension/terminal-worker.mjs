import { parentPort, workerData } from 'node:worker_threads';
import { basename } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createZenFsPod } from '../dist/realize/zenfs.js';
import { TerminalSession } from '../dist/host/terminal-session.js';

// One ZenFS singleton per worker. The hostDir and superblock are the same ones
// used by checkpoints, native editor writes and `artipod run --dir`.
let pod;
let session;
let closed = false;
const commandScope = new AsyncLocalStorage();
const checkpointScope = new AsyncLocalStorage();
const checkpointRequests = new Map();
let checkpointSequence = 0;

async function coordinateSnapshot(operation) {
  if (checkpointScope.getStore()) { return operation(); }
  const inputId = commandScope.getStore();
  if (!Number.isSafeInteger(inputId) || closed) { throw new Error('Snapshot commands require an active Artipod terminal.'); }
  const id = ++checkpointSequence;
  await new Promise((resolve, reject) => {
    checkpointRequests.set(id, { resolve, reject });
    parentPort.postMessage({ type: 'checkpoint-request', id, inputId });
  });
  try { return await checkpointScope.run(true, operation); }
  finally { if (!closed) { parentPort.postMessage({ type: 'checkpoint-complete', id }); } }
}

function close() {
  if (closed) { return; }
  closed = true;
  for (const request of checkpointRequests.values()) { request.reject(new Error('The Artipod terminal closed.')); }
  checkpointRequests.clear();
  session?.dispose();
  pod?.dispose();
  parentPort.postMessage({ type: 'exit', code: session?.lastExitCode ?? 0 });
  parentPort.close();
}

try {
  pod = await createZenFsPod({ formatVersion: 1, mounts: [{ name: 'work', path: '/', mode: 'rw', source: { kind: 'hostDir', dir: workerData.workspacePath } }] }, {
    // VS Code edits this native workspace as ordinary host files.
    storagePolicy: 'plaintext',
    proc: false,
    cwd: '/',
    identity: { kind: 'pod', name: basename(workerData.workspacePath), mode: 'local workspace' }
  });
  const rootId = pod.oci.store.getSuperblock().podId;
  if (rootId !== workerData.rootId) { throw new Error('The Artipod root changed. Reload the workspace before opening a terminal.'); }
  // Shell snapshot verbs use this same manager, including nested calls such
  // as create -> get/list. Reuse their lease without asking the host twice.
  for (const name of ['get', 'list', 'create', 'diff', 'mount', 'checkout', 'restore', 'copyTo', 'commit', 'compact', 'gc']) {
    const operation = pod.snapshots[name].bind(pod.snapshots);
    pod.snapshots[name] = (...args) => coordinateSnapshot(() => operation(...args));
  }
  session = new TerminalSession({
    sandbox: pod.createSandbox(),
    io: { write: data => parentPort.postMessage({ type: 'data', data }) },
    events: pod.events,
    banner: [
      `Artipod ${rootId}`,
      `/ = ${workerData.workspacePath}`,
      'Artipod interpreted shell. Type help or artipod; exit closes this terminal.'
    ],
    onExit: close
  });
  parentPort.postMessage({ type: 'ready', rootId });
  let queue = Promise.resolve();
  const input = async message => {
    try { await commandScope.run(message.id, () => session.handleData(message.data)); }
    catch (error) { parentPort.postMessage({ type: 'data', data: `\r\nArtipod: ${error.message}\r\n` }); }
    finally { if (!closed) { parentPort.postMessage({ type: 'done', id: message.id }); } }
  };
  parentPort.on('message', message => {
    if (message.type === 'checkpoint-response') {
      const request = checkpointRequests.get(message.id);
      if (request) {
        checkpointRequests.delete(message.id);
        if (message.error) { request.reject(new Error(message.error)); }
        else { request.resolve(); }
      }
      return;
    }
    if (message.type === 'close') { close(); return; }
    if (closed || message.type !== 'input') { return; }
    // Interrupts must reach TerminalSession while a command is executing.
    if (message.data === '\x03') { void input(message); }
    else { queue = queue.then(() => input(message)); }
  });
} catch (error) {
  parentPort.postMessage({ type: 'error', message: error.message });
  close();
}
