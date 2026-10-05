'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

/** Coordinate the extension's own shells with its snapshot boundary. External
 * native writers still need to be stopped by the caller. */
class WorkspaceOperationGate {
  constructor() { this.terminals = new Set(); this.checkpointActive = false; this.queue = Promise.resolve(); }
  checkpoint(operation) {
    const result = this.queue.catch(() => {}).then(async () => {
      if ([...this.terminals].some(terminal => terminal.busy)) {
        throw new Error('Wait for the Artipod terminal command to finish before creating or restoring a checkpoint.');
      }
      this.checkpointActive = true;
      try { return await operation(); }
      finally {
        this.checkpointActive = false;
        for (const terminal of this.terminals) { terminal.flushInput(); }
      }
    });
    this.queue = result;
    return result;
  }
}

/** VS Code PTY adapter around Artipod's actual TerminalSession. */
class ArtipodTerminal {
  constructor(vscode, backend, gate, workerPath = path.join(__dirname, 'vendor', 'terminal-worker.js')) {
    this.vscode = vscode;
    this.backend = backend;
    this.gate = gate;
    this.workerPath = workerPath;
    this.output = new vscode.EventEmitter();
    this.closedEvent = new vscode.EventEmitter();
    this.onDidWrite = this.output.event;
    this.onDidClose = this.closedEvent.event;
    this.pending = new Set();
    this.buffer = [];
    this.sequence = 0;
    this.closed = false;
    this.stopping = false;
    this.workerExited = false;
    this.workerReady = false;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // VS Code calls open after creating the terminal; a failed worker should
    // show its error in the terminal without an unhandled Promise rejection.
    void this.ready.catch(() => {});
    gate.terminals.add(this);
  }

  get busy() { return this.stopping || this.pending.size > 0; }

  open() {
    if (this.worker || this.closed) { return; }
    this.worker = new Worker(this.workerPath, {
      workerData: { workspacePath: this.backend.workspacePath, rootId: this.backend.rootId },
      execArgv: []
    });
    this.worker.on('message', message => {
      if (message.type === 'data') { this.output.fire(message.data); }
      if (message.type === 'ready') { this.workerReady = true; this.resolveReady(message.rootId); this.flushInput(); }
      if (message.type === 'done') { this.pending.delete(message.id); }
      if (message.type === 'error') { this.fail(new Error(message.message)); }
      if (message.type === 'exit') { this.close(message.code); }
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => {
      this.workerExited = true;
      if (!this.closed) { this.close(code); }
      this.releaseGate();
    });
  }

  fail(error) {
    this.output.fire(`\r\nArtipod: ${error.message}\r\n`);
    this.rejectReady(error);
    this.close(1);
  }

  handleInput(data) {
    if (this.closed) { return; }
    this.buffer.push(data);
    this.flushInput();
  }

  flushInput() {
    if (!this.workerReady || this.closed || this.gate.checkpointActive) { return; }
    for (const data of this.buffer.splice(0)) {
      const id = ++this.sequence;
      this.pending.add(id);
      this.worker.postMessage({ type: 'input', id, data });
    }
  }

  close(code) {
    if (this.closed) { return; }
    this.closed = true;
    this.buffer.length = 0;
    this.rejectReady(new Error('The Artipod terminal closed before initialization.'));
    if (this.worker && !this.workerExited) {
      // Closing the PTY does not synchronously stop its worker. Keep blocking
      // snapshots even if the last input's acknowledgement arrives meanwhile.
      this.stopping = true;
      this.termination = (async () => {
        try { await this.worker.terminate(); this.releaseGate(); }
        catch (error) {
          // A failed termination is not proof that writes stopped. The worker's
          // exit event will release the gate if it exits independently later.
          this.output.fire(`\r\nArtipod: Could not stop terminal: ${error.message}\r\n`);
        }
      })();
    } else { this.releaseGate(); }
    this.closedEvent.fire(typeof code === 'number' ? code : 0);
  }

  releaseGate() {
    this.stopping = false;
    this.pending.clear();
    this.gate.terminals.delete(this);
  }

  dispose() { this.close(); this.output.dispose(); this.closedEvent.dispose(); }
}

module.exports = { ArtipodTerminal, WorkspaceOperationGate };
