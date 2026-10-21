'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { activate } = require('../extension');
const { createVSCode } = require('./helpers');

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'artipod-activation-'));
  const workspacePath = path.join(temporary, 'workspace');
  await fs.mkdir(workspacePath);
  const vscode = createVSCode();
  vscode.workspace.getConfiguration = () => ({ get: (_name, fallback) => fallback });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath) }];
  const context = { globalStorageUri: vscode.Uri.file(path.join(temporary, 'globalStorage')), subscriptions: [] };
  t.after(async () => {
    context.subscriptions.forEach(value => value.dispose());
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const { ArtipodWorkspace } = await import('../vendor/checkpoints.mjs');
  return { workspacePath, vscode, context, ArtipodWorkspace };
}

test('activation waits for an existing pod provider before allowing restored mirror reads', async t => {
  const { workspacePath, vscode, context, ArtipodWorkspace } = await fixture(t);
  const backend = await ArtipodWorkspace.open({ workspacePath, storePath: path.join(context.globalStorageUri.fsPath, 'store') });
  await fs.writeFile(path.join(workspacePath, 'restored.txt'), 'ready on activation');
  let releaseOpen;
  const delayedOpen = new Promise(resolve => { releaseOpen = resolve; });
  let notifyOpenStarted;
  const openStarted = new Promise(resolve => { notifyOpenStarted = resolve; });
  t.mock.method(ArtipodWorkspace, 'open', async () => {
    notifyOpenStarted();
    await delayedOpen;
    return backend;
  });
  const activation = Promise.resolve(activate(context, vscode));
  let settled = false;
  void activation.then(() => { settled = true; }, () => { settled = true; });
  await openStarted;
  await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(settled, false, 'activation must remain pending while the provider backend opens');
    assert.equal(vscode.provider, undefined);
  } finally { releaseOpen(); }
  const extension = await activation;
  assert.ok(vscode.provider, 'VS Code can dispatch the first artipod read immediately after activation');
  assert.equal((await extension.getManager()).backend.rootId, backend.rootId);
  assert.equal((await vscode.provider.readFile(vscode.provider.uri('restored.txt'))).toString(), 'ready on activation');
});

test('activation rejects and reports existing-pod initialization failure', async t => {
  const { workspacePath, vscode, context, ArtipodWorkspace } = await fixture(t);
  await ArtipodWorkspace.open({ workspacePath, storePath: path.join(context.globalStorageUri.fsPath, 'store') });
  t.mock.method(ArtipodWorkspace, 'open', async () => { throw new Error('Cannot reopen the pod'); });
  const messages = [];
  vscode.window.showErrorMessage = message => {
    messages.push(message);
    // Reporting the error must not wait for the user to dismiss a notification.
    return new Promise(() => {});
  };
  await assert.rejects(activate(context, vscode), /Cannot reopen the pod/);
  assert.deepEqual(messages, ['Artipod: Cannot reopen the pod']);
  assert.equal(vscode.provider, undefined);
});

test('activation leaves a fresh stock workspace untouched until an Artipod command runs', async t => {
  const { workspacePath, vscode, context, ArtipodWorkspace } = await fixture(t);
  const open = t.mock.method(ArtipodWorkspace, 'open', () => assert.fail('fresh workspace activation must stay lazy'));
  const extension = await activate(context, vscode);
  assert.equal(open.mock.callCount(), 0);
  assert.equal(vscode.provider, undefined);
  assert.equal(typeof extension.getManager, 'function');
  assert.ok(vscode.commandsMap.has('artipod.createSnapshot'));
  assert.ok(vscode.commandsMap.has('artipod.openPodTerminal'));
  await assert.rejects(fs.access(path.join(workspacePath, '.artipod')), { code: 'ENOENT' });
});

test('provider case sensitivity follows workspace directory lookup rather than the host platform', async t => {
  for (const scenario of [
    { name: 'same directory through either spelling', alternate: { dev: 1, ino: 10 }, sensitive: false },
    { name: 'uppercase spelling is absent', error: 'ENOENT', sensitive: true },
    { name: 'uppercase spelling is a distinct entry', alternate: { dev: 1, ino: 11 }, sensitive: true },
    { name: 'uppercase spelling is on a different device', alternate: { dev: 2, ino: 10 }, sensitive: true }
  ]) {
    await t.test(scenario.name, async t => {
      const { workspacePath, vscode, context, ArtipodWorkspace } = await fixture(t);
      const backend = await ArtipodWorkspace.open({ workspacePath, storePath: path.join(context.globalStorageUri.fsPath, 'store') });
      t.mock.method(ArtipodWorkspace, 'open', async () => backend);
      const alias = path.join(path.dirname(workspacePath), 'workspace-alias');
      await fs.symlink(workspacePath, alias);
      vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(alias) }];
      const lower = path.join(backend.workspacePath, '.artipod');
      const upper = path.join(backend.workspacePath, '.ARTIPOD');
      const probes = [];
      const lstat = fs.lstat.bind(fs);
      t.mock.method(fs, 'lstat', async (filename, ...args) => {
        if (filename === lower) { probes.push(filename); return { dev: 1, ino: 10 }; }
        if (filename === upper) {
          probes.push(filename);
          if (scenario.error) { throw Object.assign(new Error(scenario.error), { code: scenario.error }); }
          return scenario.alternate;
        }
        return lstat(filename, ...args);
      });
      let registration;
      const register = vscode.workspace.registerFileSystemProvider;
      vscode.workspace.registerFileSystemProvider = (scheme, provider, options) => {
        registration = options;
        return register(scheme, provider, options);
      };
      await activate(context, vscode);
      assert.deepEqual(registration, { isCaseSensitive: scenario.sensitive });
      assert.deepEqual(probes, [lower, upper], 'probe the canonical backend root even when VS Code opened an alias');
    });
  }
});

test('unexpected case-probe errors reject activation before provider registration', async t => {
  const { workspacePath, vscode, context, ArtipodWorkspace } = await fixture(t);
  const backend = await ArtipodWorkspace.open({ workspacePath, storePath: path.join(context.globalStorageUri.fsPath, 'store') });
  t.mock.method(ArtipodWorkspace, 'open', async () => backend);
  const lstat = fs.lstat.bind(fs);
  t.mock.method(fs, 'lstat', async (filename, ...args) => {
    if (filename === path.join(backend.workspacePath, '.ARTIPOD')) {
      throw Object.assign(new Error('Cannot inspect workspace case sensitivity'), { code: 'EACCES' });
    }
    return lstat(filename, ...args);
  });
  await assert.rejects(activate(context, vscode), { code: 'EACCES' });
  assert.equal(vscode.provider, undefined);
  assert.match(vscode.lastError, /Cannot inspect workspace case sensitivity/);
});
