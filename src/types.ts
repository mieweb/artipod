/**
 * Configuration for an ArtiPod
 */
export interface ArtiPodConfig {
  /** Base path for the pod */
  basePath?: string;
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
