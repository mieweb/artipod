/**
 * Write-back for `rw` proc providers.
 *
 * After a command, every file under an `rw` provider whose content hash moved
 * away from the refresh baseline is handed to `provider.write()`. The provider
 * decides how — and whether — the write applies; a throw surfaces on stderr and
 * the file reverts on the next refresh, because the snapshot is rebuilt from
 * `read()` regardless.
 */
import { enabledProviders, providerRoot, type ProcProvider } from './registry';
import { hashContent, PROC_MOUNT, procEntries } from './snapshot';
import type { ZenFsLike } from '../sandbox/types';

export async function reconcileProc(zfs: ZenFsLike): Promise<string[]> {
  const errors: string[] = [];
  for (const provider of enabledProviders()) {
    if (provider.mode !== 'rw' || !provider.write) continue;
    for (const [path, rel] of await currentFiles(zfs, provider)) {
      let bytes: Uint8Array;
      try {
        bytes = (await zfs.promises.readFile(path)) as Uint8Array;
      } catch {
        continue; // removed by the command; the next refresh restores it
      }
      if (procEntries().get(path)?.hash === hashContent(bytes)) continue;
      try {
        await provider.write(rel, bytes);
      } catch (e) {
        errors.push(`proc: ${provider.name}: ${rel}: ${(e as Error).message}`);
      }
    }
  }
  return errors;
}

/**
 * Absolute path → provider-relative path for everything the provider currently
 * owns. Providers rooted at `/proc` itself cannot be walked (the directory is
 * shared), so only the files the last refresh wrote are considered.
 */
async function currentFiles(
  zfs: ZenFsLike,
  provider: ProcProvider,
): Promise<Map<string, string>> {
  const root = providerRoot(provider);
  const files = new Map<string, string>();
  if (!root) {
    for (const [path, entry] of procEntries()) {
      if (entry.provider === provider) files.set(path, entry.rel);
    }
    return files;
  }

  const base = `${PROC_MOUNT}/${root}`;
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await zfs.promises.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = `${dir}/${name}`;
      const stat = await zfs.promises.lstat(path);
      if (stat.isDirectory()) await walk(path);
      else files.set(path, path.slice(base.length + 1));
    }
  };
  await walk(base);
  return files;
}
