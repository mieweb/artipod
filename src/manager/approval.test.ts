/**
 * Phase 6.5 — sudo approval flow, audit provenance, blind relay, budgeted
 * sync (docs/security-model.md + docs/encryption.md are normative).
 * Done-when bullets: banned class → EPERM with NO prompt; a user without
 * the approver role cannot approve; approval mints a TTL capability visible
 * in /proc/keys that expires; audit survives push/pull; blind relay holds
 * zero keys while end-to-end digests verify.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configure, InMemory, fs as zfs, umount, mounts as zenMounts, bindContext } from '@zenfs/core';
import type { PodFs } from '../types.js';
import { OciStore } from '../oci/store.js';
import { isEncryptedBlob } from '../oci/cipher.js';
import { PodEvents } from '../events.js';
import { createZenFsPod } from '../realize/zenfs.js';
import { Keyring, makeKeysProcProvider } from './keyring.js';
import { Authority } from './authority.js';
import { ApprovalBroker } from './approval.js';
import { AuditLog, AUDIT_REF } from './audit.js';
import { OciLayoutPodStore } from './pod-store.js';
import { syncRef } from './sync.js';
import { pushEncryptedRef, pullEncryptedRef } from './encrypted-sync.js';
import type { AdminPolicy } from './policy.js';

const text = (s: string) => new TextEncoder().encode(s);

function unmountAll() {
  for (const path of [...zenMounts.keys()]) {
    if (path !== '/') umount(path);
  }
  try {
    umount('/');
  } catch {
    // first run
  }
}

const policy: AdminPolicy = {
  formatVersion: 1,
  approverRoles: { 'escape-approve': ['role:clinician-lead', 'user:dr-lead'] },
  capabilities: {
    'mount-other-pod': { approvable: true, maxTtlMs: 15 * 60_000, modes: ['ro'] },
    'docker-exec': { approvable: true, maxTtlMs: 30 * 60_000 },
    'keyring-export': { approvable: false },
    'history-delete': { approvable: false },
  },
  defaults: { approvable: false },
};

let now: number;
const clock = () => now;

beforeEach(async () => {
  unmountAll();
  await configure({ mounts: { '/': InMemory } });
  now = Date.parse('2026-06-01T12:00:00Z');
});

describe('sudo approval flow (broker rules)', () => {
  it('deny-by-policy never prompts; non-approvers cannot approve; approvals mint expiring capabilities', async () => {
    const store = new OciStore(zfs);
    await store.init();
    const keyring = new Keyring(clock);
    const events = new PodEvents();
    const audit = new AuditLog(store);
    const prompt = vi.fn(async () => ({ approved: true, approver: { principal: 'user:dr-lead' } }));
    const broker = new ApprovalBroker({ policy, keyring, events, audit, prompt, clock });
    const requests: string[] = [];
    events.on('approval:request', (e) => requests.push(e.verb));

    // 1. Banned class: instant EPERM, the human never sees a prompt.
    const banned = await broker.request({
      principal: 'agent:session-42',
      command: 'artipod keyring export',
      capability: { class: 'keyring-export', verb: 'export' },
    });
    expect(banned).toMatchObject({ ok: false, code: 'EPERM' });
    expect(prompt).not.toHaveBeenCalled();
    expect(requests).toEqual([]);

    // Disallowed mode is unapprovable too (policy says ro only).
    const rwMount = await broker.request({
      principal: 'agent:session-42',
      command: 'artipod mount clinical/x /p --rw',
      capability: { class: 'mount-other-pod', verb: 'mount', target: 'clinical/x', mode: 'rw' },
    });
    expect(rwMount.ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled();

    // 2. An approver without the policy role cannot approve.
    prompt.mockResolvedValueOnce({ approved: true, approver: { principal: 'user:intern', roles: ['role:observer'] } });
    const wrongRole = await broker.request({
      principal: 'agent:session-42',
      command: 'artipod mount clinical/8cb31a7d /patients/123 --readonly',
      capability: { class: 'mount-other-pod', verb: 'mount', target: 'clinical/8cb31a7d', mode: 'ro', ttlMs: 10 * 60_000 },
    });
    expect(wrongRole.ok).toBe(false);
    expect((wrongRole as { reason: string }).reason).toContain('escape-approve');
    expect(requests).toEqual(['mount']); // approvable classes DO surface

    // 3. A policy-granted approver mints a scoped TTL capability…
    const approved = await broker.request({
      principal: 'agent:session-42',
      command: 'artipod mount clinical/8cb31a7d /patients/123 --readonly',
      capability: { class: 'mount-other-pod', verb: 'mount', target: 'clinical/8cb31a7d', mode: 'ro', ttlMs: 60 * 60_000 },
    });
    expect(approved.ok).toBe(true);
    const name = (approved as { capabilityName: string }).capabilityName;
    // …clamped to the policy's 15 min despite the 1 h ask…
    expect((approved as { expiresAt: number }).expiresAt).toBe(now + 15 * 60_000);
    expect(broker.holds({ class: 'mount-other-pod', verb: 'mount', target: 'clinical/8cb31a7d', mode: 'ro' })).toBe(true);

    // …visible in /proc/keys (names + expiries, no material)…
    const tree = await makeKeysProcProvider(keyring).read();
    expect(tree.keys).toContain(name);
    expect(tree.keys).toContain('capability');

    // …and it expires.
    now += 16 * 60_000;
    expect(keyring.getCapability(name)).toBeNull();
    expect(broker.holds({ class: 'mount-other-pod', verb: 'mount', target: 'clinical/8cb31a7d', mode: 'ro' })).toBe(false);

    // 4. Every request/decision is on the provenance stream.
    const kinds = (await audit.read()).map((e) => e.kind);
    expect(kinds).toEqual([
      'approval:unapprovable',
      'approval:unapprovable',
      'approval:request',
      'approval:denied',
      'approval:request',
      'approval:approved',
    ]);
  });

  it('audit chain survives push/pull to a manager store', async () => {
    const store = new OciStore(zfs);
    await store.init();
    const audit = new AuditLog(store);
    await audit.append({ at: new Date(now).toISOString(), kind: 'approval:request', principal: 'agent:1' });
    await audit.append({ at: new Date(now + 1).toISOString(), kind: 'approval:approved', principal: 'agent:1', approver: 'user:dr-lead' });
    await audit.append({ at: new Date(now + 2).toISOString(), kind: 'lock' });

    await zfs.promises.mkdir('/relay-store', { recursive: true });
    const manager = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/relay-store');
    await manager.init();
    const result = await syncRef(store, manager, AUDIT_REF);
    expect(result.moved).toBe(3); // the whole chain, walked by prev links

    // The far side replays the identical stream.
    const remoteAudit = new AuditLog(manager);
    const replayed = await remoteAudit.read();
    expect(replayed.map((e) => e.kind)).toEqual(['approval:request', 'approval:approved', 'lock']);
    expect(replayed).toEqual(await audit.read());

    // Re-push is anti-entropy like everything else.
    const again = await syncRef(store, manager, AUDIT_REF);
    expect(again).toMatchObject({ moved: 0, skipped: 3 });
  });
});

describe('sudo through the pod surface', () => {
  it('wires policy + console-style prompt into the sandbox sudo command', async () => {
    await zfs.promises.mkdir('/repo', { recursive: true });
    const answers: boolean[] = [false, true];
    const pod = await createZenFsPod(
      {
        formatVersion: 1,
        name: 'approval-pod',
        mounts: [{ name: 'root', path: '/', mode: 'rw', source: { kind: 'backend', backend: 'memory' } }],
      },
      {
        adopt: zfs,
        cwd: '/repo',
        authority: {
          login: async () => {
            throw new Error('not used here');
          },
          policy,
          principal: 'agent:session-42',
          prompt: async () => ({ approved: answers.shift() ?? false, approver: { principal: 'user:dr-lead' } }),
        },
      },
    );
    const sandbox = pod.createSandbox();

    // Banned class straight from the shell: EPERM, no prompt consumed.
    const gc = await sandbox.exec('sudo artipod gc');
    expect(gc.exitCode).toBe(1);
    expect(gc.stderr).toContain('EPERM');
    expect(gc.stderr).toContain('banned by policy');
    expect(answers.length).toBe(2);

    // Denied by the human.
    const denied = await sandbox.exec('sudo --justify "need the study" artipod mount clinical/xyz /p --readonly');
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain('denied by approver');

    // Approved: the gate opens (no EPERM — the inner command now runs and
    // fails on its own terms: that ref doesn't exist in this test store),
    // the capability lands in the keyring, /proc/keys shows it.
    const ok = await sandbox.exec('sudo --justify "need the study" artipod mount clinical/xyz /p --readonly');
    expect(ok.stderr).not.toContain('EPERM');
    expect(pod.approvals!.holds({ class: 'mount-other-pod', verb: 'mount', target: 'clinical/xyz', mode: 'ro' })).toBe(true);
    const proc = await sandbox.exec('cat /proc/keys/keys');
    expect(proc.stdout).toContain('cap:mount-other-pod:clinical/xyz:ro');
    // Within the TTL, re-execution needs no fresh approval (answers exhausted).
    const again = await sandbox.exec('sudo artipod mount clinical/xyz /p --readonly');
    expect(again.stderr).not.toContain('EPERM');
    pod.dispose();
  });
});

describe('blind relay (ciphertext only, end-to-end digests)', () => {
  it('round-trips an encrypted ref through a keyless relay; tampering is caught', async () => {
    // Shared KEK between the two ends; the relay never sees it.
    const authority = await Authority.create('home-base', clock);
    const kek = authority.registerPod('shared');
    const importKek = () => crypto.subtle.importKey('raw', kek as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

    // Source pod: encrypted store with committed content.
    const src = new OciStore(zfs);
    await src.init();
    const srcKey = await importKek();
    await src.enableEncryption(srcKey);
    const layerBytes = text('DICOM-ish payload that must never transit in the clear');
    const layerDigest = await src.putBlob(layerBytes);
    const configBytes = text(JSON.stringify({ diff_ids: [layerDigest] }));
    const configDigest = await src.putBlob(configBytes);
    const manifestBytes = text(
      JSON.stringify({
        schemaVersion: 2,
        config: { mediaType: 'application/vnd.artipod.volume.v1+json', digest: configDigest, size: configBytes.length },
        layers: [{ mediaType: 'application/vnd.artipod.volume.layer.v1.chunked+encrypted', digest: layerDigest, size: layerBytes.length }],
      }),
    );
    const manifestDigest = await src.putBlob(manifestBytes);
    await src.putRef('clinical/visits:1', manifestDigest, 'application/vnd.oci.image.manifest.v1+json');

    // The ship relay: a plain layout store holding bytes it cannot read.
    await zfs.promises.mkdir('/ship-relay', { recursive: true });
    const relay = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/ship-relay');
    await relay.init();

    const pushed = await pushEncryptedRef(src, relay, 'clinical/visits:1', srcKey);
    expect(pushed.moved).toBe(3); // manifest + config + layer, all as ciphertext
    // The ref points at the sealed envelope — ciphertext like everything else.
    for (const ref of await relay.listRefs()) {
      const blob = await relay.getBlob(ref.manifestDigest);
      expect(isEncryptedBlob(blob)).toBe(true);
    }
    // Every byte on the relay is ciphertext; the plaintext never transits.
    const relayDir = (await zfs.promises.readdir('/ship-relay/blobs/sha256')) as string[];
    expect(relayDir.length).toBe(4); // 3 blobs + sealed envelope
    for (const name of relayDir) {
      const raw = (await zfs.promises.readFile(`/ship-relay/blobs/sha256/${name}`)) as Uint8Array;
      const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      expect(new TextDecoder().decode(bytes)).not.toContain('DICOM-ish');
      expect(isEncryptedBlob(bytes)).toBe(true);
    }

    // Anti-entropy holds for the encrypted path too.
    const again = await pushEncryptedRef(src, relay, 'clinical/visits:1', srcKey);
    expect(again).toMatchObject({ moved: 0, skipped: 3 });

    // Shore side: a chrooted fresh store with the same KEK pulls through
    // the relay — every hop digest-verified, then decrypted locally.
    await zfs.promises.mkdir('/shore', { recursive: true });
    const shore = bindContext({ root: '/shore' });
    const dst = new OciStore(shore.fs as unknown as import('../sandbox/types.js').ZenFsLike);
    await dst.init();
    await dst.enableEncryption(await importKek());
    const pulled = await pullEncryptedRef(relay, dst, 'clinical/visits:1', await importKek());
    expect(pulled.moved).toBe(3);
    expect(new TextDecoder().decode(await dst.getBlob(layerDigest))).toContain('DICOM-ish payload');
    expect((await dst.getRef('clinical/visits:1'))!.manifestDigest).toBe(manifestDigest);

    // A tampering relay is caught by the digest checks.
    const victim = relayDir[0];
    const tampered = (await zfs.promises.readFile(`/ship-relay/blobs/sha256/${victim}`)) as Uint8Array;
    tampered[tampered.length - 1] ^= 0xff;
    await zfs.promises.writeFile(`/ship-relay/blobs/sha256/${victim}`, tampered);
    await zfs.promises.mkdir('/shore2', { recursive: true });
    const shore2 = bindContext({ root: '/shore2' });
    const dst2 = new OciStore(shore2.fs as unknown as import('../sandbox/types.js').ZenFsLike);
    await dst2.init();
    await dst2.enableEncryption(await importKek());
    await expect(pullEncryptedRef(relay, dst2, 'clinical/visits:1', await importKek())).rejects.toThrow();
  });
});

describe('budgeted sync (constrained links)', () => {
  it('moves metadata first, respects the byte budget, resumes to completion', async () => {
    const store = new OciStore(zfs);
    await store.init();
    const layerA = text('x'.repeat(4000));
    const layerB = text('y'.repeat(4000));
    const dA = await store.putBlob(layerA);
    const dB = await store.putBlob(layerB);
    const config = text(JSON.stringify({ diff_ids: [dA, dB] }));
    const dConfig = await store.putBlob(config);
    const manifest = text(
      JSON.stringify({
        schemaVersion: 2,
        config: { mediaType: 'application/vnd.artipod.volume.v1+json', digest: dConfig, size: config.length },
        layers: [
          { mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: dA, size: layerA.length },
          { mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: dB, size: layerB.length },
        ],
      }),
    );
    const dManifest = await store.putBlob(manifest);
    await store.putRef('big:1', dManifest, 'application/vnd.oci.image.manifest.v1+json');

    await zfs.promises.mkdir('/slow-link', { recursive: true });
    const remote = new OciLayoutPodStore(zfs.promises as unknown as PodFs, '/slow-link');
    await remote.init();

    // Pass 1: enough for metadata + one layer only.
    const pass1 = await syncRef(store, remote, 'big:1', { maxBytes: manifest.length + config.length + 4000 });
    expect(pass1.complete).toBe(false);
    expect(pass1.remaining).toBe(1);
    expect(pass1.moved).toBe(3); // manifest, config, layer A — small metadata first
    // The ref pointer is withheld until every blob is there.
    expect(await remote.getRef('big:1')).toBeNull();
    expect(await remote.hasBlob(dManifest)).toBe(true);
    expect(await remote.hasBlob(dA)).toBe(true);
    expect(await remote.hasBlob(dB)).toBe(false);

    // Pass 2: anti-entropy resume — only the missing layer moves.
    const pass2 = await syncRef(store, remote, 'big:1', { maxBytes: 8000 });
    expect(pass2).toMatchObject({ complete: true, moved: 1, skipped: 3, remaining: 0 });
    expect((await remote.getRef('big:1'))!.manifestDigest).toBe(dManifest);
  });
});
