'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { ArtipodTerminal, WorkspaceOperationGate } = require('../pod-terminal');
const { createVSCode } = require('./helpers');

async function until(predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) { throw new Error('Timed out waiting for the Artipod terminal.'); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('packaged real Artipod terminal and checkpoints share the pod ID, snapshot history and native files', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-terminal-'));
  const workspacePath = path.join(temporary, 'workspace');
  await fs.mkdir(workspacePath);
  // A copied bundle outside the checkout proves workers don't silently find
  // Artipod source or dependencies in the developer's node_modules.
  const packaged = path.join(temporary, 'packaged');
  await fs.cp(path.join(__dirname, '..', 'vendor'), packaged, { recursive: true });
  const { ArtipodWorkspace } = await import(pathToFileURL(path.join(packaged, 'checkpoints.mjs')).href);
  const backend = await ArtipodWorkspace.open({ workspacePath, storePath: path.join(temporary, 'store') });
  const gate = new WorkspaceOperationGate();
  const terminal = new ArtipodTerminal(createVSCode(), backend, gate, path.join(packaged, 'terminal-worker.js'));
  let output = '';
  terminal.onDidWrite(text => { output += text; });
  t.after(async () => { terminal.dispose(); await terminal.worker?.terminate(); await fs.rm(temporary, { recursive: true, force: true }); });
  terminal.open();
  assert.equal(await terminal.ready, backend.rootId);
  assert.match(output, /Artipod interpreted shell/);
  assert.equal(JSON.parse(await fs.readFile(path.join(workspacePath, '.artipod', 'superblock.json'), 'utf8')).podId, backend.rootId);
  const execute = async command => { terminal.handleInput(command + '\r'); await until(() => !terminal.busy); };
  await execute("printf 'pod before\\n' > terminal.txt");
  assert.equal(await fs.readFile(path.join(workspacePath, 'terminal.txt'), 'utf8'), 'pod before\n');
  const before = await gate.checkpoint(() => backend.create({ label: 'native checkpoint' }));
  await execute('artipod snapshot ls');
  assert.ok(output.includes(before.checkpointId), 'the shell sees the native Chat checkpoint in Artipod history');
  await fs.writeFile(path.join(workspacePath, 'editor.txt'), 'native editor write');
  await execute("printf 'pod after\\n' > terminal.txt; printf 'new\\n' > added.txt");
  await gate.checkpoint(() => backend.restore(before.checkpointId));
  assert.equal(await fs.readFile(path.join(workspacePath, 'terminal.txt'), 'utf8'), 'pod before\n');
  await assert.rejects(fs.access(path.join(workspacePath, 'editor.txt')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(workspacePath, 'added.txt')), { code: 'ENOENT' });
  output = '';
  await execute('cat terminal.txt');
  assert.ok(output.includes('pod before'), 'the already-open shell reads restored bytes');
  await execute('exit');
  await until(() => !gate.terminals.has(terminal));
  assert.equal(terminal.closed, true);
  assert.equal(terminal.busy, false);
  await gate.checkpoint(() => backend.list());
});

test('checkpoint boundary rejects active Artipod commands and holds new input until it completes', async () => {
  const gate = new WorkspaceOperationGate();
  const terminal = { busy: true, flushes: 0, flushInput() { this.flushes++; } };
  gate.terminals.add(terminal);
  let called = false;
  await assert.rejects(gate.checkpoint(() => { called = true; }), /terminal command to finish/);
  assert.equal(called, false);
  terminal.busy = false;
  await gate.checkpoint(async () => { assert.equal(gate.checkpointActive, true); });
  assert.equal(gate.checkpointActive, false);
  assert.equal(terminal.flushes, 1);
  await assert.rejects(gate.checkpoint(async () => { throw new Error('failed restore'); }), /failed restore/);
  assert.equal(gate.checkpointActive, false, 'a failed checkpoint always releases input');
  const pty = new ArtipodTerminal(createVSCode(), {}, gate);
  const posted = [];
  pty.worker = { postMessage: message => posted.push(message), terminate() {} };
  pty.workerReady = true;
  await gate.checkpoint(async () => {
    pty.handleInput('echo deferred\r');
    assert.deepEqual(posted, [], 'terminal input cannot mutate the pod during a checkpoint');
  });
  assert.equal(posted[0].data, 'echo deferred\r');
  pty.dispose();
});

test('closing a terminal blocks checkpoints until its worker actually stops', async t => {
  for (const activeCommand of [false, true]) {
    await t.test(activeCommand ? 'active command' : 'idle worker', async () => {
      const gate = new WorkspaceOperationGate();
      const terminal = new ArtipodTerminal(createVSCode(), {}, gate);
      const posted = [];
      let stopped;
      let terminations = 0;
      terminal.worker = {
        postMessage: message => posted.push(message),
        terminate() {
          terminations++;
          return new Promise(resolve => { stopped = resolve; });
        }
      };
      terminal.workerReady = true;
      if (activeCommand) { terminal.handleInput('write workspace.txt\r'); }
      terminal.close();
      terminal.close();
      terminal.handleInput('must not run\r');
      assert.equal(terminations, 1);
      assert.equal(posted.length, activeCommand ? 1 : 0);
      // Even a final command acknowledgement cannot release a closing worker.
      terminal.pending.clear();
      assert.equal(terminal.busy, true);
      assert.equal(gate.terminals.has(terminal), true);
      await assert.rejects(gate.checkpoint(() => assert.fail('worker can still write')), /terminal command to finish/);
      stopped(0);
      await terminal.termination;
      assert.equal(terminal.busy, false);
      assert.equal(gate.terminals.has(terminal), false);
      assert.equal(await gate.checkpoint(() => 'snapshot'), 'snapshot');
      terminal.dispose();
    });
  }
});

function fakeTerminal(gate) {
  const terminal = new ArtipodTerminal(createVSCode(), {}, gate);
  const messages = [];
  terminal.worker = { postMessage: message => messages.push(message), terminate: async () => {} };
  terminal.workerReady = true;
  terminal.sequence = 100;
  return { terminal, messages };
}

test('shell snapshot coordination exempts only the requesting input and rejects other busy or closing terminals', async t => {
  for (const scenario of ['other busy', 'other closing', 'requester queued input']) {
    await t.test(scenario, async () => {
      const gate = new WorkspaceOperationGate();
      const requester = fakeTerminal(gate);
      const other = fakeTerminal(gate);
      requester.terminal.pending.add(1);
      if (scenario === 'other busy') { other.terminal.pending.add(1); }
      if (scenario === 'other closing') { other.terminal.stopping = true; }
      if (scenario === 'requester queued input') { requester.terminal.pending.add(2); }
      await requester.terminal.requestCheckpoint({ id: 10, inputId: 1 });
      assert.match(requester.messages[0].error, /terminal command to finish/);
      assert.equal(gate.checkpointActive, false);
      assert.equal(requester.terminal.checkpoints.size, 0);
      requester.terminal.dispose(); other.terminal.dispose();
    });
  }
});

test('shell capture holds both terminals input until completion, including a failed worker operation', async () => {
  const gate = new WorkspaceOperationGate();
  const requester = fakeTerminal(gate);
  const other = fakeTerminal(gate);
  requester.terminal.pending.add(1);
  const capture = requester.terminal.requestCheckpoint({ id: 10, inputId: 1 });
  await until(() => gate.checkpointActive);
  assert.deepEqual(requester.messages, [{ type: 'checkpoint-response', id: 10 }]);
  requester.terminal.handleInput('echo after-snapshot\r');
  other.terminal.handleInput('echo other-terminal\r');
  assert.equal(requester.messages.length, 1);
  assert.deepEqual(other.messages, []);
  // Worker finally sends completion after either success or capture error.
  requester.terminal.checkpoints.get(10).release();
  await capture;
  assert.equal(gate.checkpointActive, false);
  assert.equal(requester.messages[1].data, 'echo after-snapshot\r');
  assert.equal(other.messages[0].data, 'echo other-terminal\r');
  requester.terminal.dispose(); other.terminal.dispose();
});

test('closing a snapshot requester retains the capture lease until confirmed worker termination', async () => {
  const gate = new WorkspaceOperationGate();
  const requester = fakeTerminal(gate);
  const other = fakeTerminal(gate);
  let stopped;
  requester.terminal.worker.terminate = () => new Promise(resolve => { stopped = resolve; });
  requester.terminal.pending.add(1);
  const capture = requester.terminal.requestCheckpoint({ id: 10, inputId: 1 });
  await until(() => gate.checkpointActive);
  requester.terminal.close();
  other.terminal.handleInput('echo only-after-worker-exit\r');
  assert.deepEqual(other.messages, []);
  assert.equal(gate.checkpointActive, true);
  stopped(0);
  await requester.terminal.termination;
  await capture;
  assert.equal(gate.checkpointActive, false);
  assert.equal(other.messages[0].data, 'echo only-after-worker-exit\r');
  other.terminal.dispose();
});

test('real shell snapshot verbs share the two-terminal host checkpoint boundary and release on failure', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-shell-snapshot-'));
  const workspacePath = path.join(temporary, 'workspace');
  await fs.mkdir(workspacePath);
  const { ArtipodWorkspace } = await import('../vendor/checkpoints.mjs');
  const backend = await ArtipodWorkspace.open({ workspacePath, storePath: path.join(temporary, 'store') });
  const gate = new WorkspaceOperationGate();
  const requests = [];
  const checkpoint = gate.checkpoint.bind(gate);
  gate.checkpoint = (operation, request) => {
    if (request) { requests.push(request); }
    return checkpoint(operation, request);
  };
  const terminals = [0, 1].map(() => new ArtipodTerminal(createVSCode(), backend, gate));
  const output = ['', ''];
  for (const [index, terminal] of terminals.entries()) { terminal.onDidWrite(text => { output[index] += text; }); terminal.open(); }
  t.after(async () => {
    terminals.forEach(terminal => terminal.dispose());
    await Promise.all(terminals.map(terminal => terminal.termination));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await Promise.all(terminals.map(terminal => terminal.ready));
  const execute = async (index, command) => {
    terminals[index].handleInput(command + '\r');
    await until(() => !terminals[index].busy);
  };
  terminals[1].handleInput('sleep 1\r');
  await execute(0, 'artipod snapshot create blocked');
  assert.match(output[0], /terminal command to finish/);
  assert.equal((await backend.list()).length, 0);
  await until(() => !terminals[1].busy);
  output[0] = '';
  await execute(0, 'artipod snapshot create coordinated');
  assert.match(output[0], /snapshot snap-.*created/);
  assert.equal((await backend.list()).length, 1);
  await execute(0, 'artipod snapshot ls');
  assert.match(output[0], /coordinated/);
  await execute(0, 'artipod snapshot diff invalid');
  assert.match(output[0], /Invalid Artipod checkpoint ID/);
  assert.equal(gate.checkpointActive, false);
  assert.equal(terminals[0].checkpoints.size, 0);
  await execute(1, "printf 'after failure' > resumed.txt");
  assert.equal(await fs.readFile(path.join(workspacePath, 'resumed.txt'), 'utf8'), 'after failure');
  assert.equal(requests.length, 4, 'all four shell snapshot operations pass through the shared gate');
  assert.ok(requests.every(request => request.terminal === terminals[0]));
});

test('a crashed worker releases its active snapshot lease and buffered peer input', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-snapshot-crash-'));
  const workerPath = path.join(temporary, 'crash-worker.cjs');
  await fs.writeFile(workerPath, `
    const { parentPort } = require('node:worker_threads');
    parentPort.postMessage({ type: 'ready', rootId: 'test-pod' });
    parentPort.on('message', message => {
      if (message.type === 'input') parentPort.postMessage({ type: 'checkpoint-request', id: 1, inputId: message.id });
      if (message.type === 'checkpoint-response' && !message.error) parentPort.postMessage({ type: 'data', data: 'lease held' });
      if (message.type === 'crash') process.exit(1);
    });
  `);
  const gate = new WorkspaceOperationGate();
  const requester = new ArtipodTerminal(createVSCode(), {}, gate, workerPath);
  const peer = fakeTerminal(gate);
  let output = '';
  requester.onDidWrite(value => { output += value; });
  t.after(async () => {
    requester.dispose(); peer.terminal.dispose();
    await requester.termination;
    await fs.rm(temporary, { recursive: true, force: true });
  });
  requester.open();
  await requester.ready;
  requester.handleInput('capture\r');
  await until(() => output.includes('lease held'));
  assert.equal(gate.checkpointActive, true);
  peer.terminal.handleInput('echo after-crash\r');
  assert.deepEqual(peer.messages, []);
  requester.worker.postMessage({ type: 'crash' });
  await until(() => requester.workerExited && !gate.checkpointActive);
  assert.equal(gate.terminals.has(requester), false);
  assert.equal(peer.messages[0].data, 'echo after-crash\r');
});
