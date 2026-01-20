import { ArtiPod } from 'artipod';

export interface PodStateResource {
  id: string;
  initialized: boolean;
  mounts: Array<{
    name: string;
    path: string;
    readOnly: boolean;
  }>;
  hasContainer: boolean;
}

export interface FileTreeResource {
  path: string;
  tree: string;
}

export interface PromptContextResource {
  prompt: string;
  truncated: boolean;
}

/**
 * Get pod state as a resource
 */
export async function getPodState(pod: ArtiPod | null): Promise<PodStateResource | null> {
  if (!pod) {
    return null;
  }

  const mounts = [];
  const mountNames = pod.getMountNames();
  for (const name of mountNames) {
    const mount = pod.getMount(name)!;
    mounts.push({
      name,
      path: mount.getRootPath(),
      readOnly: mount.isReadOnly(),
    });
  }

  return {
    id: pod.getId(),
    initialized: true, // Pod is always initialized if it exists in our manager
    mounts,
    hasContainer: pod.hasContainer(),
  };
}

/**
 * Get file tree for a specific mount or all mounts
 */
export async function getFileTree(
  pod: ArtiPod | null,
  mountName?: string
): Promise<FileTreeResource[]> {
  if (!pod) {
    return [];
  }

  const results: FileTreeResource[] = [];

  if (mountName) {
    // Get tree for specific mount
    const mount = pod.getMount(mountName);
    if (mount) {
      const files = await mount.list();
      const tree = formatFileTree(files);
      results.push({
        path: `/${mountName}`,
        tree,
      });
    }
  } else {
    // Get tree for all mounts
    const mountNames = pod.getMountNames();
    for (const name of mountNames) {
      const mount = pod.getMount(name)!;
      const files = await mount.list();
      const tree = formatFileTree(files);
      results.push({
        path: `/${name}`,
        tree,
      });
    }
  }

  return results;
}

/**
 * Get prompt context for the pod
 */
export async function getPromptContext(
  pod: ArtiPod | null,
  maxTokens?: number
): Promise<PromptContextResource | null> {
  if (!pod) {
    return null;
  }

  const prompt = await pod.buildPrompt({
    maxSize: maxTokens,
    includeFiles: true,
  });
  
  // Check if truncated by looking for truncation marker
  const truncated = prompt.includes('TRUNCATED');

  return {
    prompt,
    truncated,
  };
}

/**
 * Format file list as a tree structure
 */
function formatFileTree(files: Array<{ path: string; size: number }>): string {
  if (files.length === 0) {
    return '(empty)';
  }

  const lines: string[] = [];
  
  // Build tree structure
  const tree = new Map<string, Array<{ path: string; size: number }>>();
  
  for (const file of files) {
    const parts = file.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    
    if (!tree.has(dir)) {
      tree.set(dir, []);
    }
    tree.get(dir)!.push(file);
  }

  // Sort directories
  const sortedDirs = Array.from(tree.keys()).sort();

  for (const dir of sortedDirs) {
    const dirFiles = tree.get(dir)!;
    
    if (dir) {
      lines.push(`${dir}/`);
    }

    // Sort files by name
    dirFiles.sort((a, b) => {
      const aName = a.path.split('/').pop()!;
      const bName = b.path.split('/').pop()!;
      return aName.localeCompare(bName);
    });

    for (const file of dirFiles) {
      const name = file.path.split('/').pop()!;
      const sizeStr = formatSize(file.size);
      const indent = dir ? '  ' : '';
      lines.push(`${indent}${name} (${sizeStr})`);
    }
  }

  return lines.join('\n');
}

/**
 * Format file size in human-readable format
 */
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const size = bytes / Math.pow(1024, i);
  
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
