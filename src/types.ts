/**
 * Configuration for an ArtiPod
 */
export interface ArtiPodConfig {
  /** Base path for the pod */
  basePath?: string;
}

/**
 * Options for creating an ArtiPod
 */
export interface ArtiPodOptions {
  /** Unique identifier for the pod. If not provided, a random hex ID will be generated */
  id?: string;
  /** Base directory for pod workspaces. Required unless useMainMount is false */
  workspaceDir?: string;
  /** If true (default), automatically create a writable 'main' mount */
  useMainMount?: boolean;
  /** Initial mounts to add to the pod */
  mounts?: import('./artimount.js').ArtiMount[];
  /** Filesystem implementation for pod-level operations and the auto-created main mount (default: node:fs/promises adapter) */
  fs?: import('./podfs.js').PodFs;
}

/**
 * File information returned by list operations
 */
export interface FileInfo {
  /** Relative path to the file */
  path: string;
  /** File size in bytes */
  size: number;
}
