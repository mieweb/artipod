import 'core-js/actual/typed-array/to-base64.js';
import 'core-js/actual/typed-array/from-base64.js';
import { calculateJwkThumbprint, decodeProtectedHeader, flattenedVerify, importJWK, type JWK } from 'jose';

export const STATEMENT_TYPES = {
  publisher: 'artipod-m0-publisher+jws',
  approval: 'artipod-m0-approval+jws',
  status: 'artipod-m0-status+jws',
} as const;
export const MAX_APPROVAL_MS = 60 * 60 * 1000;
export const MAX_FRESHNESS_MS = 5 * 60 * 1000;
const MAX_EVIDENCE_BYTES = 64 * 1024;

export interface ExecutionSubject {
  digest: string;
  descriptorDigest: string;
  layers: readonly string[];
  dependencies: readonly string[];
  capabilities: readonly string[];
}

export interface TestIdentity {
  id: string;
  publicKey: JWK;
}

export interface AdmissionPolicy {
  publishers: readonly TestIdentity[];
  approvers: readonly TestIdentity[];
  audience: string;
  mode: 'trusted-browser';
  clock(): number;
  freshnessMs: number;
  revokedApprovalIds: ReadonlySet<string>;
}

export interface ReleaseEvidence {
  publisher: string;
  approval: string;
  status: string;
}

export interface VerifiedRelease {
  kind: 'release';
  subject: Readonly<ExecutionSubject>;
  publisher: string;
  approver: string;
  approvalId: string;
  validUntil: number;
}

export class RevokedApprovalError extends Error {
  constructor(readonly approvalId: string) {
    super('Admission denied: revoked approval');
  }
}

function denied(reason: string): never {
  throw new Error(`Admission denied: ${reason}`);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) denied('invalid statement');
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512) denied('invalid string');
  return value;
}

function digest(value: unknown): string {
  const result = text(value);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) denied('invalid digest');
  return result;
}

function strings(value: unknown, digests = false): readonly string[] {
  if (!Array.isArray(value) || value.length > 256) denied('invalid requirements');
  return Object.freeze(value.map(digests ? digest : text));
}

function subject(value: unknown): Readonly<ExecutionSubject> {
  const parsed = record(value);
  return Object.freeze({
    digest: digest(parsed.digest),
    descriptorDigest: digest(parsed.descriptorDigest),
    layers: strings(parsed.layers, true),
    dependencies: strings(parsed.dependencies, true),
    capabilities: strings(parsed.capabilities),
  });
}

function sameSubject(actual: unknown, expected: ExecutionSubject): void {
  const parsed = subject(actual);
  if (parsed.digest !== expected.digest || parsed.descriptorDigest !== expected.descriptorDigest) denied('subject mismatch');
  for (const field of ['layers', 'dependencies', 'capabilities'] as const) {
    if (parsed[field].length !== expected[field].length || parsed[field].some((value, index) => value !== expected[field][index])) {
      denied('composition mismatch');
    }
  }
}

function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) denied('invalid time');
  return value;
}

function validity(claims: Record<string, unknown>, now: number, maxLifetime: number): number {
  const issuedAt = time(claims.issuedAt);
  const expiresAt = time(claims.expiresAt);
  if (issuedAt > now || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > maxLifetime) {
    denied('expired or invalid validity window');
  }
  return expiresAt;
}

export async function evidenceDigest(evidence: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(evidence));
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function verifyStatement(wire: string, type: string, identities: readonly TestIdentity[]) {
  if (typeof wire !== 'string' || new TextEncoder().encode(wire).byteLength > MAX_EVIDENCE_BYTES) denied('missing or oversized evidence');
  const envelope = record(JSON.parse(wire));
  if (Object.keys(envelope).some((key) => !['protected', 'payload', 'signature'].includes(key))) denied('unsupported envelope');
  for (const field of ['protected', 'payload', 'signature']) {
    if (typeof envelope[field] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(envelope[field])) denied('invalid base64url envelope');
  }
  const header = decodeProtectedHeader(envelope);
  if (header.alg !== 'ES256' || header.typ !== type || header.cty !== 'application/json') denied('wrong statement type');
  if (Object.keys(header).some((key) => !['alg', 'typ', 'cty', 'kid'].includes(key))) denied('unsupported signing header');
  const matches = identities.filter((identity) => identity.id === header.kid);
  if (matches.length !== 1) denied('unknown or ambiguous signer');
  const identity = matches[0];
  if (identity.publicKey.kty !== 'EC' || identity.publicKey.crv !== 'P-256' || identity.publicKey.d) denied('invalid host public key');
  const key = await importJWK(identity.publicKey, 'ES256');
  const verified = await flattenedVerify(envelope as unknown as Parameters<typeof flattenedVerify>[0], key, { algorithms: ['ES256'] });
  const claims = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(verified.payload)));
  if (claims.schema !== 'artipod.m0/v1') denied('unsupported statement schema');
  return { claims, identity, thumbprint: await calculateJwkThumbprint(identity.publicKey) };
}

export async function verifyRelease(
  expected: ExecutionSubject,
  supplied: ReleaseEvidence,
  hostPolicy: AdmissionPolicy,
): Promise<VerifiedRelease> {
  const pinnedSubject = subject(expected);
  const evidence = { ...supplied };
  const policy = {
    ...hostPolicy,
    publishers: hostPolicy.publishers.map((identity) => ({ ...identity, publicKey: { ...identity.publicKey } })),
    approvers: hostPolicy.approvers.map((identity) => ({ ...identity, publicKey: { ...identity.publicKey } })),
  };
  if (!Number.isSafeInteger(policy.freshnessMs) || policy.freshnessMs <= 0 || policy.freshnessMs > MAX_FRESHNESS_MS) denied('invalid host freshness policy');
  const publisher = await verifyStatement(evidence.publisher, STATEMENT_TYPES.publisher, policy.publishers);
  sameSubject(publisher.claims.subject, pinnedSubject);
  const approval = await verifyStatement(evidence.approval, STATEMENT_TYPES.approval, policy.approvers);
  sameSubject(approval.claims.subject, pinnedSubject);
  if (publisher.identity.id === approval.identity.id || publisher.thumbprint === approval.thumbprint) denied('publisher cannot self-approve');
  if (approval.claims.publisherEvidenceDigest !== await evidenceDigest(evidence.publisher)) denied('publisher evidence mismatch');
  if (approval.claims.audience !== policy.audience || approval.claims.mode !== policy.mode) denied('wrong audience or mode');
  const approvalId = text(approval.claims.id);
  const status = await verifyStatement(evidence.status, STATEMENT_TYPES.status, [approval.identity]);
  if (status.claims.approvalId !== approvalId || status.claims.approvalEvidenceDigest !== await evidenceDigest(evidence.approval)) denied('status subject mismatch');
  if (status.claims.revoked === true || policy.revokedApprovalIds.has(approvalId)) throw new RevokedApprovalError(approvalId);
  if (status.claims.revoked !== false) denied('invalid revocation status');
  const now = time(policy.clock());
  const validUntil = Math.min(
    validity(publisher.claims, now, MAX_APPROVAL_MS),
    validity(approval.claims, now, MAX_APPROVAL_MS),
    validity(status.claims, now, policy.freshnessMs),
  );
  return Object.freeze({ kind: 'release', subject: pinnedSubject, publisher: publisher.identity.id, approver: approval.identity.id, approvalId, validUntil });
}