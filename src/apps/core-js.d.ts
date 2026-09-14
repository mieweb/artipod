// core-js ships no types for its side-effect entry points; admission.ts loads
// these two on demand (see ensureBase64Codecs).
declare module 'core-js/actual/typed-array/to-base64.js';
declare module 'core-js/actual/typed-array/from-base64.js';
