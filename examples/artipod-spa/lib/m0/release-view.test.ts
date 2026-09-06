import { describe, expect, it } from 'vitest';
import { captureApplication, openApprovedView } from './release-view';
import { exportJWK, FlattenedSign, generateKeyPair } from 'jose';
import { evidenceDigest, MAX_FRESHNESS_MS, STATEMENT_TYPES, type AdmissionPolicy } from './admission';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
function source() {
  const files = new Map([
    ['/app/artipod.json', encoder.encode(JSON.stringify({ apiVersion: 'artipod.io/v1', kind: 'SPAPod', metadata: { name: 'viewer' }, spec: { entrypoint: 'index.html', capabilities: ['case:read'], dependencies: [] } }))],
    ['/app/index.html', encoder.encode('<script type="module" src="./main.js"></script>')],
    ['/app/main.js', encoder.encode('document.title = "Approved";')],
  ]);
  return { files, paths: [...files.keys()], read: async (path: string) => files.get(path)! };
}

async function signedFixture() {
  const application = source();
  const captured = await captureApplication(application);
  const publisher = await generateKeyPair('ES256');
  const reviewer = await generateKeyPair('ES256');
  const now = Date.UTC(2026, 8, 5);
  let clock = now;
  const sign = async (type: string, id: string, key: CryptoKey, claims: object) => JSON.stringify(await new FlattenedSign(encoder.encode(JSON.stringify({ schema: 'artipod.m0/v1', issuedAt: now, expiresAt: now + MAX_FRESHNESS_MS, ...claims })))
    .setProtectedHeader({ alg: 'ES256', typ: type, cty: 'application/json', kid: id }).sign(key));
  const attribution = await sign(STATEMENT_TYPES.publisher, 'publisher', publisher.privateKey, { subject: captured.subject });
  const approval = await sign(STATEMENT_TYPES.approval, 'reviewer', reviewer.privateKey, {
    id: 'approval', subject: captured.subject, publisherEvidenceDigest: await evidenceDigest(attribution), audience: 'local', mode: 'trusted-browser',
  });
  const status = await sign(STATEMENT_TYPES.status, 'reviewer', reviewer.privateKey, { approvalId: 'approval', approvalEvidenceDigest: await evidenceDigest(approval), revoked: false });
  const revoked = new Set<string>();
  const policy: AdmissionPolicy = {
    publishers: [{ id: 'publisher', publicKey: await exportJWK(publisher.publicKey) }],
    approvers: [{ id: 'reviewer', publicKey: await exportJWK(reviewer.publicKey) }],
    audience: 'local', mode: 'trusted-browser', clock: () => clock, freshnessMs: MAX_FRESHNESS_MS, revokedApprovalIds: revoked,
  };
  return { application, policy, evidence: { publisher: attribution, approval, status }, revoked, expire() { clock += MAX_FRESHNESS_MS; } };
}

describe('M0 immutable approved projection', () => {
  it('uses deterministic OCI bytes independent of filesystem enumeration', async () => {
    const application = source();
    const first = await captureApplication(application);
    application.paths.reverse();
    expect((await captureApplication(application)).subject).toEqual(first.subject);
  });

  it('copies input and output buffers and never serves the mutable source after admission', async () => {
    const fixture = await signedFixture();
    const view = await openApprovedView(fixture.application, fixture.evidence, fixture.policy);
    fixture.application.files.get('/app/main.js')!.fill(0);
    const returned = view.read('/app/main.js');
    returned.fill(0);
    expect(decoder.decode(view.read('/app/main.js'))).toContain('Approved');
    await expect(openApprovedView(fixture.application, fixture.evidence, fixture.policy)).rejects.toThrow('subject mismatch');
  });

  it.each(['/case/subject.json', '/app/../secret', '/app/%2e%2e/secret', '/app//secret'])('denies non-application or escaped snapshot paths: %s', async (path) => {
    const application = source();
    application.paths.push(path);
    await expect(captureApplication(application)).rejects.toThrow(/(Denied|Invalid) application path/);
  });

  it('accepts safe dotted directory names consistently with descriptor paths', async () => {
    const application = source();
    application.paths.push('/app/assets.v1/main.js');
    application.files.set('/app/assets.v1/main.js', encoder.encode('export const version = 1;'));
    expect(decoder.decode((await captureApplication(application)).read('/app/assets.v1/main.js'))).toContain('version');
  });

  it('rejects unpinned external dependency declarations', async () => {
    const application = source();
    application.files.set('/app/artipod.json', encoder.encode(JSON.stringify({ apiVersion: 'artipod.io/v1', kind: 'SPAPod', metadata: { name: 'viewer' }, spec: { entrypoint: 'index.html', capabilities: [], dependencies: ['https://outside/script.js'] } })));
    await expect(captureApplication(application)).rejects.toThrow('dependencies are not supported');
  });

  it.each(['dispose', 'expire', 'revoke'])('stops projected reads after %s', async (action) => {
    const fixture = await signedFixture();
    const view = await openApprovedView(fixture.application, fixture.evidence, fixture.policy);
    expect(() => view.read('/case/subject.json')).toThrow('Unprojected');
    if (action === 'dispose') view.dispose();
    if (action === 'expire') fixture.expire();
    if (action === 'revoke') fixture.revoked.add('approval');
    expect(() => view.read('/app/main.js')).toThrow('no longer active');
  });
});