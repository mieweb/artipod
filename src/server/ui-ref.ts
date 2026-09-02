/**
 * The pinned UI artifact (serve plan S2, V6). The static export of the
 * artipod-sync demo ships as a digest-pinned OCI artifact — the first
 * `artipod serve` that wants a UI pulls it into the local store, verifies,
 * materializes, and serves it from there forever after.
 *
 * Resolution is LOCAL-FIRST: `ARTIPOD_UI_DIR` (serve a local build) beats
 * `ARTIPOD_UI_REF` in the local store (a locally imported export) beats the
 * remote fetch of the pin below. UI_DIGEST === null means "no artifact
 * published yet": the remote path stays dormant and serve falls back to the
 * headless landing.
 */

/** Default local-store ref for the UI (also what the release script publishes). */
export const UI_REF = 'artipod-ui:latest';

/** Remote artifact home (release step pushes here — ask-first per plan). */
export const UI_REMOTE_REF = 'ghcr.io/mieweb/artipod-ui:latest';

/**
 * Manifest digest pin for UI_REMOTE_REF, updated per release. `null` until
 * the first artifact is published — no mutable tag is ever trusted at
 * runtime, so null disables remote fetch entirely.
 */
export const UI_DIGEST: string | null = null;
