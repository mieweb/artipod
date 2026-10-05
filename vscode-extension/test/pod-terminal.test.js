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
