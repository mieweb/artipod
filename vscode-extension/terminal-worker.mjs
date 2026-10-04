import { parentPort, workerData } from 'node:worker_threads';
import { basename } from 'node:path';
import { createZenFsPod } from '../dist/realize/zenfs.js';
import { TerminalSession } from '../dist/host/terminal-session.js';

// One ZenFS singleton per worker. The hostDir and superblock are the same ones
// used by checkpoints, native editor writes and `artipod run --dir`.
let pod;
let session;
let closed = false;
function close() {
  if (closed) { return; }
  closed = true;
  session?.dispose();
  pod?.dispose();
  parentPort.postMessage({ type: 'exit', code: session?.lastExitCode ?? 0 });
  parentPort.close();
}

try {
  pod = await createZenFsPod({ formatVersion: 1, mounts: [{ name: 'work', path: '/', mode: 'rw', source: { kind: 'hostDir', dir: workerData.workspacePath } }] }, {
    proc: false,
    cwd: '/',
    identity: { kind: 'pod', name: basename(workerData.workspacePath), mode: 'Ozwell workspace' }
  });
  const rootId = pod.oci.store.getSuperblock().podId;
  if (rootId !== workerData.rootId) { throw new Error('The Artipod root changed. Reload the workspace before opening a terminal.'); }
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
    try { await session.handleData(message.data); }
    catch (error) { parentPort.postMessage({ type: 'data', data: `\r\nArtipod: ${error.message}\r\n` }); }
    finally { if (!closed) { parentPort.postMessage({ type: 'done', id: message.id }); } }
  };
  parentPort.on('message', message => {
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
