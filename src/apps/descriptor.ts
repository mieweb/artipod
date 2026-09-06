export interface ExecutableDescriptor {
  name: string;
  entrypoint: string;
  capabilities: string[];
  dependencies: string[];
  mounts: { path: string; profile: string; mode: 'ro' }[];
}

export function applicationPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) throw new Error('Invalid application path');
  const path = value.startsWith('/app/') ? value.slice(5) : value;
  if (!/^[a-zA-Z0-9_-]+(?:[./][a-zA-Z0-9_-]+)*$/.test(path)) throw new Error('Invalid application path');
  return path;
}

export function parseExecutableDescriptor(bytes: Uint8Array): ExecutableDescriptor {
  if (bytes.byteLength > 64 * 1024) throw new Error('Application descriptor too large');
  const descriptor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (descriptor?.apiVersion !== 'artipod.io/v1' || descriptor?.kind !== 'SPAPod' ||
      typeof descriptor.metadata?.name !== 'string' || !descriptor.metadata.name.trim()) {
    throw new Error('Not a supported SPAPod descriptor');
  }
  const spec = descriptor.spec;
  const entrypoint = applicationPath(spec?.entrypoint);
  if (!entrypoint.endsWith('.html')) throw new Error('Browser entrypoint must be HTML');
  const capabilities: unknown = spec.capabilities ?? [];
  const dependencies: unknown = spec.dependencies ?? [];
  if (!Array.isArray(capabilities) || capabilities.length > 64 || capabilities.some(value => typeof value !== 'string' || !value || value.length > 128)) {
    throw new Error('Invalid capabilities');
  }
  if (!Array.isArray(dependencies) || dependencies.length) throw new Error('External executable dependencies are not supported');
  const requested: unknown = spec.mounts ?? [];
  if (!Array.isArray(requested) || requested.length > 1) throw new Error('Unsupported application mounts');
  const mounts = requested.map(mount => {
    if (mount?.path !== '/case' || mount?.profile !== 'CasePod' || mount?.mode !== 'ro') throw new Error('Unsupported application mount');
    return { path: '/case', profile: 'CasePod', mode: 'ro' as const };
  });
  return { name: descriptor.metadata.name, entrypoint, capabilities, dependencies: [], mounts };
}