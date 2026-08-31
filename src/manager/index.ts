/**
 * @artipod/core/manager — pod hosting + durability (plan Phase 6) and the
 * authority layer (Phase 6.5): PodStore implementations, anti-entropy sync,
 * the HTTP store client, the graduated pod/session host, and the keyring /
 * lease / grant / policy / approval machinery from docs/encryption.md +
 * docs/security-model.md.
 */
export type { PodStore, ZenFsPodStore } from './pod-store.js';
export { OciLayoutPodStore } from './pod-store.js';
export { syncRef, syncAllRefs, walkImageDigests, storeTransport, materializeImage } from './sync.js';
export type { SyncResult, SyncOptions, MaterializeOptions } from './sync.js';
export { HttpPodStore } from './http-store.js';
export { PodSessionHost, SESSION_ID_PATTERN } from './session-host.js';
export type { SessionHostOptions, SessionAcquire } from './session-host.js';
export { buildOverlayHead, pushOverlay } from './overlay-sync.js';
export type { OverlayHeadOptions, OverlayHeadResult, OverlayPushResult } from './overlay-sync.js';
export { mergeHeads, isAncestor } from './merge.js';
export type { MergeOptions, MergeResult, ContentMerger } from './merge.js';

// --- Phase 6.5: encryption custody + authority ------------------------------
export { Keyring, PodLockedError, makeKeysProcProvider } from './keyring.js';
export type { KeyringEntryInfo } from './keyring.js';
export { Authority, DelegatedAuthority, verifyLease } from './authority.js';
export type { Lease, DelegationCert, OfflineGrant, SignedCrl, LoginResult } from './authority.js';
export { enrollDevice, HighWaterClock, unlockWithGrant } from './grants.js';
export type { DeviceKeyPair, UnlockOptions } from './grants.js';
export { PodLocker, kekName } from './locker.js';
export type { LockMode, PodLockerOptions } from './locker.js';
export { evaluateCapability, canApprove, narrowPolicy, verifyPolicy, APPROVER_ROLE } from './policy.js';
export type { AdminPolicy, CapabilityRule } from './policy.js';
export { ApprovalBroker, classifyCommand, capabilityName } from './approval.js';
export type { CapabilityRequest, ApprovalPrompt, ApprovalPromptResult, ApprovalOutcome } from './approval.js';
export { AuditLog, walkAuditDigests, AUDIT_MEDIA_TYPE, AUDIT_REF } from './audit.js';
export type { AuditEvent } from './audit.js';
export { pushEncryptedRef, pullEncryptedRef, ENCRYPTED_REF_MEDIA_TYPE } from './encrypted-sync.js';
export type { EncryptedSyncResult } from './encrypted-sync.js';
export { canonicalJson, signJson, verifyJson, generateSigningKeyPair, generateDeviceKeyPair, wrapKeyForDevice, unwrapKeyForDevice, scopeMatch } from './crypto.js';
export type { SigningKeyPair, WrappedKey } from './crypto.js';

// --- Phase 6.6: lazy hydration & site cache ---------------------------------
export {
  Hydrator,
  BandwidthScheduler,
  CachingPodStore,
  fetchBlobResumable,
  persistPartial,
  makePrefetchTool,
  pathGlobMatch,
  hasRange,
  ANNOTATION_HYDRATION,
  ANNOTATION_LAYER_INDEX,
  ANNOTATION_LAYER_GROUP,
} from './hydration.js';
export type { HydrationPolicy, HydrationState, HydrationLayerState, IndexPullResult, Lane, RangeReadable } from './hydration.js';
