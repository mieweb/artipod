/**
 * `@artipod/core/apps` — run SPAPod applications in the browser.
 *
 * Browser-safe and framework-free. A consumer supplies the pod filesystem
 * (`ApplicationFiles`), serves `runtime-sw.js` from its site root, and renders
 * whatever UI it likes over `createBrowserRuntime().store`.
 *
 * Trust boundary: an admitted application is trusted same-origin code with the
 * host page's browser authority. This layer decides *whether* code may run
 * (signed release evidence or explicit development authorization); it is not
 * hostile-code isolation. See docs/apps.md.
 */
export { applicationPath, parseExecutableDescriptor } from './descriptor.js';
export type { ExecutableDescriptor } from './descriptor.js';
export { applicationSource, inspectApplication } from './files.js';
export type { ApplicationFiles } from './files.js';
export { captureApplication, openApprovedView } from './capture.js';
export type { ApplicationSource } from './capture.js';
export {
  evidenceDigest,
  MAX_APPROVAL_MS,
  MAX_FRESHNESS_MS,
  STATEMENT_TYPES,
  verifyRelease,
} from './admission.js';
export type { AdmissionPolicy, ExecutionSubject, ReleaseEvidence, TestIdentity, VerifiedRelease } from './admission.js';
export { boundedResponse, createBrowserRuntime, createSnapshotStore } from './runtime.js';
export type { BrowserRuntime, RuntimeSnapshot, SnapshotStore } from './runtime.js';
export { observeRuntimeTelemetry, parseRuntimeTelemetry } from './telemetry.js';
export type { RuntimeTelemetry } from './telemetry.js';
export { controlRuntimeLifecycle } from './lifecycle.js';
export type { LifecycleController, LifecycleSnapshot, LifecycleState } from './lifecycle.js';
