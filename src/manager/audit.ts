/**
 * The pod audit/provenance stream (docs/security-model.md §sudo, property 4):
 * an append-only hash chain of events stored as digest-addressed blobs with
 * a ref pointing at the head — so `syncRef` carries it like any other ref
 * and it survives push/pull by construction.
 */
import { sha256, type Digest } from '../oci/digest.js';
import { canonicalJson } from './crypto.js';
import type { PodStore } from './pod-store.js';

export const AUDIT_MEDIA_TYPE = 'application/vnd.artipod.audit.v1+json';
export const AUDIT_REF = 'pod/audit';

export interface AuditEvent {
  at: string;
  kind:
    | 'approval:request'
    | 'approval:approved'
    | 'approval:denied'
    | 'approval:unapprovable'
    | 'login'
    | 'lock'
    | 'grant:unlock'
    | 'capability:expired';
  principal?: string;
  capability?: { class: string; verb: string; target?: string; mode?: string; ttlMs?: number };
  approver?: string;
  reason?: string;
  details?: Record<string, string>;
}

interface AuditRecord {
  prev: Digest | null;
  event: AuditEvent;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class AuditLog {
  constructor(
    private readonly store: PodStore,
    private readonly refName: string = AUDIT_REF,
  ) {}

  async append(event: AuditEvent): Promise<Digest> {
    const head = await this.store.getRef(this.refName);
    const record: AuditRecord = { prev: head?.manifestDigest ?? null, event };
    const bytes = encoder.encode(canonicalJson(record));
    const digest = await sha256(bytes);
    await this.store.putBlob(bytes, digest);
    await this.store.putRef(this.refName, digest, AUDIT_MEDIA_TYPE);
    return digest;
  }

  /** Oldest-first replay of the chain. */
  async read(): Promise<AuditEvent[]> {
    const head = await this.store.getRef(this.refName);
    const out: AuditEvent[] = [];
    let cursor: Digest | null = head?.manifestDigest ?? null;
    while (cursor) {
      const record = JSON.parse(decoder.decode(await this.store.getBlob(cursor))) as AuditRecord;
      out.push(record.event);
      cursor = record.prev;
    }
    return out.reverse();
  }
}

/** Every digest in an audit chain, head → genesis (for sync walks). */
export async function walkAuditDigests(store: PodStore, headDigest: Digest): Promise<Digest[]> {
  const digests: Digest[] = [];
  let cursor: Digest | null = headDigest;
  while (cursor) {
    digests.push(cursor);
    const record = JSON.parse(decoder.decode(await store.getBlob(cursor))) as AuditRecord;
    cursor = record.prev;
  }
  return digests;
}
