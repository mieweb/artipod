/**
 * The on-disk authority home for `artipod serve --encrypt` (S5.5):
 * `<dir>/authority.json` (signing keypair, pkcs8) and `<dir>/keks.json`
 * (podId → raw KEK, base64). This is RAW KEY MATERIAL — dir 0700, files
 * 0600, and the ask-first rule applies before a key-issuing serve faces a
 * network. Created on first `--encrypt`; "serve makes a key if one is not
 * there" is this file's contract.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Authority } from '../manager/authority.js';
import {
  exportSigningKeyPair,
  fromBase64,
  generateSigningKeyPair,
  importSigningKeyPair,
  toBase64,
} from '../manager/crypto.js';

interface AuthorityFile {
  formatVersion: 1;
  name: string;
  publicKeySpki: string;
  privateKeyPkcs8: string;
  createdAt: string;
}

export interface LoadedAuthority {
  authority: Authority;
  /** True when this call created the signing key (first --encrypt). */
  created: boolean;
}

export async function loadOrCreateAuthority(dir: string, name: string, clock?: () => number): Promise<LoadedAuthority> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700); // pre-existing dirs tighten too
  const file = join(dir, 'authority.json');
  let created = false;
  let keys;
  let authorityName = name;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as AuthorityFile;
    keys = await importSigningKeyPair(parsed);
    authorityName = parsed.name;
  } catch {
    keys = await generateSigningKeyPair(true);
    const exported = await exportSigningKeyPair(keys);
    const record: AuthorityFile = { formatVersion: 1, name, ...exported, createdAt: new Date().toISOString() };
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    created = true;
  }
  const authority = Authority.from(authorityName, keys, clock);
  for (const [podId, b64] of Object.entries(await readKeks(dir))) {
    authority.registerPod(podId, fromBase64(b64));
  }
  return { authority, created };
}

async function readKeks(dir: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(join(dir, 'keks.json'), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** The pod's KEK, minting + persisting one when the authority has none. */
export async function ensurePodKek(
  dir: string,
  authority: Authority,
  podId: string,
): Promise<{ kek: Uint8Array; created: boolean }> {
  const keks = await readKeks(dir);
  if (keks[podId]) return { kek: fromBase64(keks[podId]), created: false }; // registered at load
  const kek = authority.registerPod(podId);
  keks[podId] = toBase64(kek);
  await writeFile(join(dir, 'keks.json'), `${JSON.stringify(keks, null, 2)}\n`, { mode: 0o600 });
  return { kek, created: true };
}
