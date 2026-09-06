import { sha256, writeTar } from '../oci/index.js';
import { verifyRelease, type AdmissionPolicy, type ExecutionSubject, type ReleaseEvidence } from './admission.js';
import { applicationPath, parseExecutableDescriptor } from './descriptor.js';

export interface ApplicationSource {
  paths: readonly string[];
  read(path: string): Promise<Uint8Array>;
}

const encoder = new TextEncoder();
const encode = (value: unknown) => encoder.encode(JSON.stringify(value));

export async function captureApplication(source: ApplicationSource) {
  const paths = [...source.paths].sort();
  if (paths.length === 0 || paths.length > 128 || new Set(paths).size !== paths.length) throw new Error('Invalid application paths');
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const path of paths) {
    if (!path.startsWith('/app/')) throw new Error('Denied application path');
    applicationPath(path);
    const bytes = new Uint8Array(await source.read(path));
    total += bytes.byteLength;
    if (bytes.byteLength > 1024 * 1024 || total > 8 * 1024 * 1024) throw new Error('Application too large');
    files.set(path, bytes);
  }
  const descriptor = files.get('/app/artipod.json');
  if (!descriptor) throw new Error('Missing application descriptor or entrypoint');
  const requirements = parseExecutableDescriptor(descriptor);
  if (!files.has(`/app/${requirements.entrypoint}`)) throw new Error('Missing application descriptor or entrypoint');
  const tar = writeTar([...files].map(([path, content]) => ({ path: path.slice(5), type: 'file', content, mode: 0o644, mtimeMs: 0 })));
  const layerDigest = await sha256(tar);
  const config = encode({ architecture: 'wasm', os: 'browser', rootfs: { type: 'layers', diff_ids: [layerDigest] } });
  const manifest = encode({
    schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: await sha256(config), size: config.byteLength },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: layerDigest, size: tar.byteLength }],
  });
  const subject: Readonly<ExecutionSubject> = Object.freeze({
    digest: await sha256(manifest), descriptorDigest: await sha256(descriptor), layers: Object.freeze([layerDigest]),
    dependencies: Object.freeze([]), capabilities: Object.freeze([...requirements.capabilities]),
  });
  return Object.freeze({
    subject,
    entrypoint: requirements.entrypoint,
    read(path: string): Uint8Array {
      const bytes = files.get(path);
      if (!bytes) throw new Error('Unprojected application path');
      return new Uint8Array(bytes);
    },
  });
}

export async function openApprovedView(source: ApplicationSource, evidence: ReleaseEvidence, policy: AdmissionPolicy) {
  const captured = await captureApplication(source);
  const approval = await verifyRelease(captured.subject, evidence, policy);
  let disposed = false;
  return Object.freeze({
    approval,
    entrypoint: captured.entrypoint,
    dispose() { disposed = true; },
    read(path: string): Uint8Array {
      if (disposed || policy.clock() >= approval.validUntil || policy.revokedApprovalIds.has(approval.approvalId)) {
        throw new Error('Approval no longer active');
      }
      return captured.read(path);
    },
  });
}