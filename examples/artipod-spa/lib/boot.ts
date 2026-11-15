/**
 * App boot singletons (spa-ui-plan §4): ONE KeysService over browser
 * adapters, ONE UiStateIO over the right medium, registry actions bound
 * once. Also the ref/URL helpers shared by catalog and workspace.
 */
import { browserAdapters } from './services/adapters';
import { KeysService } from './services/keys-service';
import { UiStateIO } from './services/ui-state';
import { registryStateMedium } from './services/registry-medium';
import { registryActions } from './stores/registry';
import { initFileSystem } from './filesystem';

export type { OpenMode } from './services/ui-state';
import type { OpenMode } from './services/ui-state';

export interface Route {
  id: string;
  isRef: boolean;
  mode: OpenMode;
  runIntent?: boolean;
  /** ?publish=<name:tag> — publish right after the workspace boots. */
  publishIntent?: string;
}

export const workspaceUrl = (id: string, mode: OpenMode = 'rw'): string =>
  `/?artipod=${encodeURIComponent(id)}${mode === 'rw' ? '' : `&mode=${mode}`}`;

/** `_`-prefixed tags are open drafts; everything else seals on first push (serve default). */
export const isOpenRef = (ref: string): boolean => ref.slice(ref.lastIndexOf(':') + 1).startsWith('_');
export const setOpenTag = (ref: string, open: boolean): string => {
  const i = ref.lastIndexOf(':');
  if (i === -1) return ref;
  const tag = ref.slice(i + 1).replace(/^_+/, '');
  return `${ref.slice(0, i)}:${open ? '_' : ''}${tag}`;
};
export const OPEN_DRAFT_TIP =
  'Checked: the tag starts with _ — an open draft anyone can keep editing (collaborative; can be renamed away later). Unchecked: the tag SEALS on publish — an immutable milestone that can never move or be deleted.';

/** Next free open tag for a fork of `ref`: me/play:1 → me/play:_2 (_3…). */
export const nextDraftRef = (ref: string, existing: Set<string>): string => {
  const i = ref.lastIndexOf(':');
  if (i === -1) return ref;
  const name = ref.slice(0, i);
  const tag = ref.slice(i + 1).replace(/^_+/, '');
  const numeric = /^\d+$/.test(tag);
  let n = numeric ? Number(tag) + 1 : 2;
  const make = () => (numeric ? `${name}:_${n}` : `${name}:_${tag}.${n}`);
  let candidate = make();
  while (existing.has(candidate)) {
    n += 1;
    candidate = make();
  }
  return candidate;
};

export function parseRoute(search: string): Route | null {
  const params = new URLSearchParams(search);
  const id = params.get('artipod');
  if (!id) return null;
  const modeParam = params.get('mode');
  const mode: OpenMode = modeParam === 'cow' || modeParam === 'ro' ? modeParam : 'rw';
  return { id, isRef: id.includes(':'), mode, runIntent: params.get('run') === '1', publishIntent: params.get('publish') ?? undefined };
}

// ── singletons ───────────────────────────────────────────────────────────────

let keysSingleton: KeysService | null = null;

export function keys(): KeysService {
  keysSingleton ??= new KeysService(browserAdapters());
  return keysSingleton;
}

let ioSingleton: Promise<{ io: UiStateIO; registry: ReturnType<typeof registryActions> }> | null = null;

export function uiState(): Promise<{ io: UiStateIO; registry: ReturnType<typeof registryActions> }> {
  ioSingleton ??= (async () => {
    await initFileSystem();
    const io = new UiStateIO(registryStateMedium(() => import('./filesystem')));
    return { io, registry: registryActions(io) };
  })().catch(error => { ioSingleton = null; throw error; });
  return ioSingleton;
}

/** Await the existing registry queue without opening storage as a side effect. */
export async function flushUiState(): Promise<void> {
  await (await ioSingleton)?.io.flush();
}

/** Core has reopened its saved generation and warned that old writes may be lost. */
export async function acknowledgeUiStateRecovery(): Promise<void> {
  await (await ioSingleton)?.io.acknowledgeRecovery();
}

let bootstrapActor: string | null = null;
/** Opaque login principal: obtaining a key must never open/write the registry. */
export async function actorId(): Promise<string> {
  if (bootstrapActor) return bootstrapActor;
  const name = 'artipod-profile-id';
  try {
    const saved = localStorage.getItem(name);
    if (saved && /^browser:[0-9a-f-]{36}$/.test(saved)) return bootstrapActor = saved;
  } catch { /* Storage restrictions still permit a volatile principal. */ }
  bootstrapActor = `browser:${crypto.randomUUID()}`;
  try { localStorage.setItem(name, bootstrapActor); } catch { /* Volatile identity. */ }
  return bootstrapActor;
}
