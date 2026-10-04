/**
 * The UI ref (serve plan S2, V6 re-amendment). The static export of the
 * artipod-sync demo ships bundled in the npm package as `dist-ui/`;
 * resolution is LOCAL-FIRST: `ARTIPOD_UI_DIR` (serve a local build) beats
 * `ARTIPOD_UI_REF`/UI_REF in the local store (a locally imported export)
 * beats the bundled dist-ui, then the headless landing.
 */

/** Default local-store ref for the UI (what `artipod import out <ref>` targets). */
export const UI_REF = 'artipod-ui:latest';
