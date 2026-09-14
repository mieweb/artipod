import { beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, FlattenedSign, generateKeyPair } from 'jose';
import {
  evidenceDigest, MAX_APPROVAL_MS, MAX_FRESHNESS_MS, STATEMENT_TYPES, verifyRelease,
  type AdmissionPolicy, type ExecutionSubject, type ReleaseEvidence, type TestIdentity,
} from './admission.js';

const now = Date.UTC(2026, 8, 5, 12);
const hash = (byte: string) => `sha256:${byte.repeat(64)}`;
const expected: ExecutionSubject = {
  digest: hash('a'), descriptorDigest: hash('b'), layers: [hash('c'), hash('d')],
  dependencies: [hash('e')], capabilities: ['case:read'],
};
type Signer = TestIdentity & { privateKey: CryptoKey };
let human: Signer;
let organization: Signer;
let reviewer: Signer;
let outsider: Signer;

async function identity(id: string): Promise<Signer> {
  const keys = await generateKeyPair('ES256');
  return { id, privateKey: keys.privateKey, publicKey: await exportJWK(keys.publicKey) };
}

async function sign(signer: Signer, type: string, claims: Record<string, unknown>): Promise<string> {
  return JSON.stringify(await new FlattenedSign(new TextEncoder().encode(JSON.stringify({ schema: 'artipod.apps/v1', ...claims })))
    .setProtectedHeader({ alg: 'ES256', typ: type, cty: 'application/json', kid: signer.id })
    .sign(signer.privateKey));
}

function policy(overrides: Partial<AdmissionPolicy> = {}): AdmissionPolicy {
  return {
    publishers: [human, organization], approvers: [reviewer], audience: 'artipod-m0-local', mode: 'trusted-browser',
    clock: () => now, freshnessMs: MAX_FRESHNESS_MS, revokedApprovalIds: new Set(), ...overrides,
  };
}

async function fixture(options: {
  publisher?: Signer; approver?: Signer; attribution?: Record<string, unknown>;
  approval?: Record<string, unknown>; status?: Record<string, unknown>;
} = {}): Promise<ReleaseEvidence> {
  const publisher = await sign(options.publisher ?? human, STATEMENT_TYPES.publisher, {
    subject: expected, claimedAuthor: 'Synthetic author', issuedAt: now - 1000, expiresAt: now + MAX_APPROVAL_MS - 1000,
    ...options.attribution,
  });
  const approver = options.approver ?? reviewer;
  const approval = await sign(approver, STATEMENT_TYPES.approval, {
    subject: expected, publisherEvidenceDigest: await evidenceDigest(publisher), id: 'approval-1', audience: 'artipod-m0-local',
    mode: 'trusted-browser', issuedAt: now - 1000, expiresAt: now + MAX_APPROVAL_MS - 1000, ...options.approval,
  });
  const status = await sign(approver, STATEMENT_TYPES.status, {
    approvalId: 'approval-1', approvalEvidenceDigest: await evidenceDigest(approval), revoked: false,
    issuedAt: now - 1000, expiresAt: now + MAX_FRESHNESS_MS - 1000, ...options.status,
  });
  return { publisher, approval, status };
}

beforeAll(async () => {
  [human, organization, reviewer, outsider] = await Promise.all([
    identity('m0-human-publisher'), identity('m0-organization-publisher'), identity('m0-reviewer'), identity('unknown-publisher'),
  ]);
});

describe('M0 release admission with real ES256 signatures', () => {
  it.each(['human', 'organization'])('accepts independently approved %s attribution', async (kind) => {
    const signer = kind === 'human' ? human : organization;
    const result = await verifyRelease(expected, await fixture({ publisher: signer }), policy());
    expect(result).toMatchObject({ kind: 'release', publisher: signer.id, approver: reviewer.id, approvalId: 'approval-1', validUntil: now + MAX_FRESHNESS_MS - 1000 });
    expect(Object.isFrozen(result.subject.layers)).toBe(true);
  });

  it.each(['publisher', 'approval', 'status'] as const)('rejects missing %s evidence', async (field) => {
    const evidence = await fixture();
    evidence[field] = '';
    await expect(verifyRelease(expected, evidence, policy())).rejects.toThrow();
  });

  it.each(['publisher', 'approval', 'status'] as const)('rejects tampered %s signatures', async (field) => {
    const evidence = await fixture();
    const envelope = JSON.parse(evidence[field]);
    envelope.signature = (envelope.signature[0] === 'A' ? 'B' : 'A') + envelope.signature.slice(1);
    evidence[field] = JSON.stringify(envelope);
    await expect(verifyRelease(expected, evidence, policy())).rejects.toThrow();
  });

  it('rejects unknown signers', async () => {
    await expect(verifyRelease(expected, await fixture({ publisher: outsider }), policy())).rejects.toThrow('unknown');
  });

  it('rejects padded standard base64 even when a platform decoder accepts it', async () => {
    const evidence = await fixture();
    const envelope = JSON.parse(evidence.publisher);
    envelope.signature += '==';
    evidence.publisher = JSON.stringify(envelope);
    await expect(verifyRelease(expected, evidence, policy())).rejects.toThrow('base64url');
  });

  it('rejects a publisher acting as reviewer', async () => {
    await expect(verifyRelease(expected, await fixture({ approver: human }), policy())).rejects.toThrow('unknown');
    await expect(verifyRelease(expected, await fixture({ approver: human }), policy({ approvers: [human] }))).rejects.toThrow('self-approve');
  });

  it('rejects the same key masquerading under another reviewer id', async () => {
    const alias = { ...human, id: 'reviewer-alias' };
    await expect(verifyRelease(expected, await fixture({ approver: alias }), policy({ approvers: [alias] }))).rejects.toThrow('self-approve');
  });

  it.each([
    { digest: hash('f') }, { descriptorDigest: hash('f') }, { layers: [hash('d'), hash('c')] },
    { layers: [hash('c')] }, { dependencies: [hash('f')] }, { capabilities: ['case:write'] },
  ])('rejects changed composition %j', async (change) => {
    await expect(verifyRelease({ ...expected, ...change }, await fixture(), policy())).rejects.toThrow(/subject|composition/);
  });

  it.each([{ audience: 'other-environment' }, { mode: 'isolate' }])('rejects wrong audience/mode %j', async (approval) => {
    await expect(verifyRelease(expected, await fixture({ approval }), policy())).rejects.toThrow('audience or mode');
  });

  it.each([
    { expiresAt: now }, { issuedAt: now + 1 }, { issuedAt: now - 2 * MAX_APPROVAL_MS }, { expiresAt: 'tomorrow' },
  ])('rejects invalid approval validity %j', async (approval) => {
    await expect(verifyRelease(expected, await fixture({ approval }), policy())).rejects.toThrow(/validity|time/);
  });

  it('rejects unknown schemas and oversized evidence', async () => {
    await expect(verifyRelease(expected, await fixture({ approval: { schema: 'other' } }), policy())).rejects.toThrow('schema');
    await expect(verifyRelease(expected, { ...await fixture(), status: ' '.repeat(65537) }, policy())).rejects.toThrow('oversized');
  });

  it('rejects status or attribution transplanted between approvals', async () => {
    const evidence = await fixture();
    const different = await fixture({ publisher: organization });
    await expect(verifyRelease(expected, { ...evidence, publisher: different.publisher }, policy())).rejects.toThrow('publisher evidence');
    await expect(verifyRelease(expected, { ...evidence, status: different.status }, policy())).rejects.toThrow('status subject');
  });

  it('rejects signed and locally known revocations', async () => {
    await expect(verifyRelease(expected, await fixture({ status: { revoked: true } }), policy())).rejects.toThrow('revoked');
    await expect(verifyRelease(expected, await fixture(), policy({ revokedApprovalIds: new Set(['approval-1']) }))).rejects.toThrow('revoked');
  });

  it('uses signed freshness, never a caller-supplied cache timestamp', async () => {
    const evidence = await fixture();
    await expect(verifyRelease(expected, evidence, policy({ clock: () => now + MAX_FRESHNESS_MS - 1000 }))).rejects.toThrow('validity');
    await expect(verifyRelease(expected, evidence, policy({ clock: () => now + MAX_FRESHNESS_MS - 1001 }))).resolves.toMatchObject({ kind: 'release' });
    await expect(verifyRelease(expected, await fixture({ status: { expiresAt: now + MAX_APPROVAL_MS } }), policy())).rejects.toThrow('validity');
  });

  it('caps the offline window at approval expiry and host freshness', async () => {
    const evidence = await fixture({ approval: { expiresAt: now + 1000 } });
    expect((await verifyRelease(expected, evidence, policy())).validUntil).toBe(now + 1000);
    await expect(verifyRelease(expected, evidence, policy({ freshnessMs: Infinity }))).rejects.toThrow('freshness');
  });

  it('copies the subject before asynchronous verification', async () => {
    const mutable = { ...expected, layers: [...expected.layers] };
    const checking = verifyRelease(mutable, await fixture(), policy());
    mutable.layers.reverse();
    expect((await checking).subject.layers).toEqual(expected.layers);
  });
});