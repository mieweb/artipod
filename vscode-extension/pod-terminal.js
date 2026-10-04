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
    this.workerReady = false;
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // VS Code calls open after creating the terminal; a failed worker should
    // show its error in the terminal without an unhandled Promise rejection.
    void this.ready.catch(() => {});
    gate.terminals.add(this);
  }

  get busy() { return this.pending.size > 0; }

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
    this.worker.on('exit', code => { if (!this.closed) { this.close(code); } });
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
    this.gate.terminals.delete(this);
    this.pending.clear();
    this.buffer.length = 0;
    this.rejectReady(new Error('The Artipod terminal closed before initialization.'));
    void this.worker?.terminate();
    this.closedEvent.fire(typeof code === 'number' ? code : 0);
  }

  dispose() { this.close(); this.output.dispose(); this.closedEvent.dispose(); }
}

module.exports = { ArtipodTerminal, WorkspaceOperationGate };
