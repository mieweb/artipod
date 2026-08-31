/**
 * Signing + wrapping primitives for the authority chain (docs/encryption.md).
 * ECDSA P-256 for signatures (universally available in WebCrypto — Ed25519
 * still isn't), ephemeral ECDH P-256 + AES-GCM for wrapping KEKs to devices.
 * Everything is isomorphic: `globalThis.crypto` only.
 */

const subtle = () => globalThis.crypto.subtle;

const SIGN_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;
const ECDH_ALG = { name: 'ECDH', namedCurve: 'P-256' } as const;

export const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

export const fromBase64 = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)));
    }
    return v;
  });
}

export interface SigningKeyPair {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** base64 SPKI — the wire form used in certs and verification. */
  publicKeyB64: string;
}

export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const pair = (await subtle().generateKey(SIGN_ALG, false, ['sign', 'verify'])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle().exportKey('spki', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyB64: toBase64(spki) };
}

export async function importVerifyKey(publicKeyB64: string): Promise<CryptoKey> {
  return subtle().importKey('spki', fromBase64(publicKeyB64) as unknown as ArrayBuffer, SIGN_ALG, true, ['verify']);
}

/** Sign a document over its canonical JSON with the `sig` field removed. */
export async function signJson<T extends { sig?: string }>(doc: T, privateKey: CryptoKey): Promise<T> {
  const { sig: _omit, ...unsigned } = doc;
  const bytes = new TextEncoder().encode(canonicalJson(unsigned));
  const sig = new Uint8Array(await subtle().sign(SIGN_PARAMS, privateKey, bytes as unknown as ArrayBuffer));
  return { ...doc, sig: toBase64(sig) };
}

export async function verifyJson(doc: { sig?: string }, publicKeyB64: string): Promise<boolean> {
  if (!doc.sig) return false;
  const { sig, ...unsigned } = doc;
  const bytes = new TextEncoder().encode(canonicalJson(unsigned));
  const key = await importVerifyKey(publicKeyB64);
  return subtle().verify(SIGN_PARAMS, key, fromBase64(sig) as unknown as ArrayBuffer, bytes as unknown as ArrayBuffer);
}

// --- device wrapping (offline grants) ---------------------------------------

export interface DeviceKeyPair {
  /** `device:<hex>` — derived from the public key, stable across reloads. */
  id: string;
  /** Non-extractable ECDH private key. Persist via structured clone (IndexedDB). */
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyB64: string;
}

export async function generateDeviceKeyPair(): Promise<DeviceKeyPair> {
  const pair = (await subtle().generateKey(ECDH_ALG, false, ['deriveKey'])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle().exportKey('spki', pair.publicKey));
  const hash = new Uint8Array(await subtle().digest('SHA-256', spki as unknown as ArrayBuffer));
  const id = `device:${Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  return { id, privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyB64: toBase64(spki) };
}

export interface WrappedKey {
  /** base64 SPKI of the ephemeral ECDH public key. */
  epk: string;
  iv: string;
  ciphertext: string;
}

async function deriveWrapKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return subtle().deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Wrap raw KEK bytes to a device public key (ephemeral-static ECDH). */
export async function wrapKeyForDevice(rawKek: Uint8Array, devicePublicKeyB64: string): Promise<WrappedKey> {
  const devicePub = await subtle().importKey('spki', fromBase64(devicePublicKeyB64) as unknown as ArrayBuffer, ECDH_ALG, true, []);
  const ephemeral = (await subtle().generateKey(ECDH_ALG, false, ['deriveKey'])) as CryptoKeyPair;
  const wrapKey = await deriveWrapKey(ephemeral.privateKey, devicePub);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv as unknown as ArrayBuffer }, wrapKey, rawKek as unknown as ArrayBuffer));
  const epk = new Uint8Array(await subtle().exportKey('spki', ephemeral.publicKey));
  return { epk: toBase64(epk), iv: toBase64(iv), ciphertext: toBase64(ct) };
}

/** Unwrap to a non-extractable AES-GCM key — raw bits never reach JS. */
export async function unwrapKeyForDevice(wrapped: WrappedKey, devicePrivateKey: CryptoKey): Promise<CryptoKey> {
  const epk = await subtle().importKey('spki', fromBase64(wrapped.epk) as unknown as ArrayBuffer, ECDH_ALG, true, []);
  const wrapKey = await deriveWrapKey(devicePrivateKey, epk);
  const raw = new Uint8Array(
    await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(wrapped.iv) as unknown as ArrayBuffer },
      wrapKey,
      fromBase64(wrapped.ciphertext) as unknown as ArrayBuffer,
    ),
  );
  return subtle().importKey('raw', raw as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Simple `*` glob for authority scopes (`clinical/*`, `crew/*`, `*`). */
export function scopeMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(value);
}
