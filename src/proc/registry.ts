/**
 * The proc provider registry.
 *
 * A *provider* projects host state into the `/proc` tree. It is deliberately
 * shaped like a kernel module — name, description, version, load state — so
 * `lsmod` / `modinfo` / `modprobe` fall out naturally.
 *
 * App-agnostic: artipod-sync ships only the built-in `storage` provider; every
 * other projection is registered by whatever app embeds the sandbox.
 */

/** A provider's projection: path relative to the provider root → file content. */
export type ProcTree = Record<string, string | Uint8Array>;

export interface ProcProvider {
  /** Module name — also the default directory under `/proc`. No slashes. */
  name: string;
  description?: string;
  version?: string;
  /** `rw` providers must supply `write()`; their files are reconciled after each command. */
  mode: 'ro' | 'rw';
  /**
   * Directory under `/proc` that this provider owns, defaulting to `name`.
   * `''` writes straight into `/proc` (for single-file projections such as
   * `/proc/route.json`) and gives up new-file detection.
   */
  root?: string;
  /** Called on every snapshot refresh. */
  read(): Promise<ProcTree>;
  /** `rw` only. A throw surfaces on stderr and the file reverts on next refresh. */
  write?(relPath: string, content: Uint8Array): Promise<void>;
}

export interface ProcModule {
  provider: ProcProvider;
  enabled: boolean;
}

const modules = new Map<string, ProcModule>();

/** Registers a provider (enabled). Returns the unregister function. */
export function registerProcProvider(provider: ProcProvider): () => void {
  if (provider.name.includes('/') || !provider.name) {
    throw new Error(`proc provider name must be a single path segment: '${provider.name}'`);
  }
  if (modules.has(provider.name)) {
    throw new Error(`proc provider '${provider.name}' is already registered`);
  }
  if (provider.mode === 'rw' && !provider.write) {
    throw new Error(`proc provider '${provider.name}' is rw but has no write()`);
  }
  modules.set(provider.name, { provider, enabled: true });
  return () => {
    if (modules.get(provider.name)?.provider === provider) modules.delete(provider.name);
  };
}

export function listProviders(): ProcModule[] {
  return [...modules.values()].sort((a, b) => a.provider.name.localeCompare(b.provider.name));
}

export function getProvider(name: string): ProcModule | undefined {
  return modules.get(name);
}

/** `modprobe` / `modprobe -r`. Returns false when there is no such provider. */
export function setProviderEnabled(name: string, enabled: boolean): boolean {
  const module = modules.get(name);
  if (!module) return false;
  module.enabled = enabled;
  return true;
}

export function enabledProviders(): ProcProvider[] {
  return listProviders()
    .filter((m) => m.enabled)
    .map((m) => m.provider);
}

/** The `/proc` subdirectory a provider owns, `''` meaning `/proc` itself. */
export function providerRoot(provider: ProcProvider): string {
  return provider.root ?? provider.name;
}

/** Test helper — drops every registration. */
export function clearProcProviders(): void {
  modules.clear();
}
