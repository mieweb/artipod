import { expect, it } from 'vitest';
import { exportJWK, FlattenedSign, generateKeyPair } from 'jose';
import { writeFile } from 'node:fs/promises';
import { fixtureFiles } from './fixtures';
import { captureApplication } from './release-view';
import { evidenceDigest, MAX_APPROVAL_MS, MAX_FRESHNESS_MS, STATEMENT_TYPES, verifyRelease } from './admission';

it('provisions test-only host identities and signed fixture evidence without exporting private keys', async () => {
  const keys = await Promise.all(['m0-human-publisher', 'm0-organization-publisher', 'm0-reviewer'].map(async (id) => {
    const pair = await generateKeyPair('ES256');
    return { id, privateKey: pair.privateKey, publicKey: await exportJWK(pair.publicKey) };
  }));
  const [human, organization, reviewer] = keys;
  const application = await captureApplication({
    paths: Object.keys(fixtureFiles).filter((path) => path.startsWith('/app/')),
    async read(path) { const value = fixtureFiles[path]; return typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value); },
  });
  const now = Date.now();
  const sign = async (identity: typeof human, type: string, claims: object) => JSON.stringify(await new FlattenedSign(new TextEncoder().encode(JSON.stringify({ schema: 'artipod.m0/v1', issuedAt: now, expiresAt: now + MAX_APPROVAL_MS, ...claims })))
    .setProtectedHeader({ alg: 'ES256', typ: type, cty: 'application/json', kid: identity.id }).sign(identity.privateKey));
  const publisher = await sign(organization, STATEMENT_TYPES.publisher, { subject: application.subject, claimedAuthor: 'Synthetic M0 author' });
  const approvalId = crypto.randomUUID();
  const approval = await sign(reviewer, STATEMENT_TYPES.approval, {
    id: approvalId, subject: application.subject, publisherEvidenceDigest: await evidenceDigest(publisher), audience: 'artipod-m0-local', mode: 'trusted-browser',
  });
  const status = await sign(reviewer, STATEMENT_TYPES.status, {
    approvalId, approvalEvidenceDigest: await evidenceDigest(approval), revoked: false, expiresAt: now + MAX_FRESHNESS_MS,
  });
  const publicIdentity = (identity: typeof human) => ({ id: identity.id, publicKey: identity.publicKey });
  const fixture = {
    policy: { publishers: [publicIdentity(human), publicIdentity(organization)], approvers: [publicIdentity(reviewer)], audience: 'artipod-m0-local', mode: 'trusted-browser' as const, freshnessMs: MAX_FRESHNESS_MS },
    evidence: { publisher, approval, status },
  };
  for (const wire of Object.values(fixture.evidence)) {
    for (const field of Object.values(JSON.parse(wire))) expect(field).toMatch(/^[A-Za-z0-9_-]+$/);
  }
  const verified = await verifyRelease(application.subject, fixture.evidence, { ...fixture.policy, clock: () => Date.now(), revokedApprovalIds: new Set() });
  expect(verified.publisher).toBe(organization.id);
  expect(keys.every((identity) => !identity.privateKey.extractable && !identity.publicKey.d)).toBe(true);
  const output = process.env.ARTIPOD_M0_FIXTURE_OUT;
  if (output) {
    await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
    console.log(`Public M0 host fixture written to ${output}; valid until ${new Date(verified.validUntil).toISOString()}`);
  }
});