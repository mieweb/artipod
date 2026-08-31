/**
 * @artipod/core/manager — pod hosting + durability (plan Phase 6):
 * PodStore implementations, anti-entropy sync of digest-addressed blobs +
 * refs, the HTTP store client, and the graduated pod/session host.
 * Keyring, leases and policy join in Phase 6.5.
 */
export type { PodStore, ZenFsPodStore } from './pod-store.js';
export { OciLayoutPodStore } from './pod-store.js';
export { syncRef, syncAllRefs, walkImageDigests, storeTransport, materializeImage } from './sync.js';
export type { SyncResult, MaterializeOptions } from './sync.js';
export { HttpPodStore } from './http-store.js';
export { PodSessionHost, SESSION_ID_PATTERN } from './session-host.js';
export type { SessionHostOptions, SessionAcquire } from './session-host.js';
