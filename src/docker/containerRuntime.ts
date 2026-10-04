import Docker from 'dockerode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Container runtime type
 */
export type ContainerRuntimeType = 'docker' | 'podman';

/**
 * Container runtime mode
 */
export type ContainerRuntimeMode = 'rootless' | 'rootful';

/**
 * Container runtime information
 */
export interface ContainerRuntimeInfo {
  /** The detected runtime type */
  type: ContainerRuntimeType;
  
  /** Whether running in rootless mode */
  mode: ContainerRuntimeMode;
  
  /** The socket path being used */
  socketPath: string;
  
  /** Runtime version string */
  version?: string;
}

/**
 * Cached runtime instance and info
 */
let cachedDocker: Docker | null = null;
let cachedRuntimeInfo: ContainerRuntimeInfo | null = null;

/**
 * Socket paths to check, in order of preference (rootless first)
 */
function getSocketPaths(): Array<{ path: string; type: ContainerRuntimeType; mode: ContainerRuntimeMode }> {
  const uid = process.getuid?.() ?? 0;
  const xdgRuntimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  const homeDir = os.homedir();
  
  return [
    // Podman rootless (preferred)
    { 
      path: path.join(xdgRuntimeDir, 'podman', 'podman.sock'),
      type: 'podman',
      mode: 'rootless'
    },
    // Docker rootless
    { 
      path: path.join(xdgRuntimeDir, 'docker.sock'),
      type: 'docker',
      mode: 'rootless'
    },
    // Docker Desktop on macOS (runs as user)
    { 
      path: path.join(homeDir, '.docker', 'run', 'docker.sock'),
      type: 'docker',
      mode: 'rootless'
    },
    // Colima on macOS
    { 
      path: path.join(homeDir, '.colima', 'default', 'docker.sock'),
      type: 'docker',
      mode: 'rootless'
    },
    // Lima on macOS
    { 
      path: path.join(homeDir, '.lima', 'default', 'sock', 'docker.sock'),
      type: 'docker',
      mode: 'rootless'
    },
    // Rancher Desktop on macOS
    { 
      path: path.join(homeDir, '.rd', 'docker.sock'),
      type: 'docker',
      mode: 'rootless'
    },
    // Podman machine on macOS
    { 
      path: path.join(homeDir, '.local', 'share', 'containers', 'podman', 'machine', 'podman.sock'),
      type: 'podman',
      mode: 'rootless'
    },
    // Podman rootful (fallback)
    { 
      path: '/run/podman/podman.sock',
      type: 'podman',
      mode: 'rootful'
    },
    // Docker rootful (fallback)
    { 
      path: '/var/run/docker.sock',
      type: 'docker',
      mode: 'rootful'
    },
  ];
}

/**
 * Check if a socket exists and is accessible
 */
function socketExists(socketPath: string): boolean {
  try {
    fs.accessSync(socketPath, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the available container runtime
 * Prefers rootless runtimes over rootful
 * 
 * @returns Runtime info or null if no runtime is available
 */
export async function detectRuntime(): Promise<ContainerRuntimeInfo | null> {
  // Return cached info if available
  if (cachedRuntimeInfo) {
    return cachedRuntimeInfo;
  }

  // Check DOCKER_HOST environment variable first
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost) {
    // Parse unix:// or tcp:// URLs
    let socketPath: string | undefined;
    let isUnix = false;
    
    if (dockerHost.startsWith('unix://')) {
      socketPath = dockerHost.slice(7);
      isUnix = true;
    }
    
    if (isUnix && socketPath && socketExists(socketPath)) {
      const docker = new Docker({ socketPath });
      try {
        const info = await docker.version();
        const isPodman = info.Components?.some(c => 
          c.Name.toLowerCase().includes('podman')
        ) ?? false;
        
        cachedRuntimeInfo = {
          type: isPodman ? 'podman' : 'docker',
          mode: socketPath.includes('/run/user/') || socketPath.includes(os.homedir()) 
            ? 'rootless' 
            : 'rootful',
          socketPath,
          version: info.Version,
        };
        cachedDocker = docker;
        return cachedRuntimeInfo;
      } catch {
        // DOCKER_HOST set but not working, continue checking other sockets
      }
    }
  }

  // Check socket paths in order of preference
  for (const { path: socketPath, type, mode } of getSocketPaths()) {
    if (!socketExists(socketPath)) {
      continue;
    }

    const docker = new Docker({ socketPath });
    try {
      const info = await docker.version();
      
      // Verify the type matches what we expect
      const isPodman = info.Components?.some(c => 
        c.Name.toLowerCase().includes('podman')
      ) ?? false;
      
      cachedRuntimeInfo = {
        type: isPodman ? 'podman' : type,
        mode,
        socketPath,
        version: info.Version,
      };
      cachedDocker = docker;
      return cachedRuntimeInfo;
    } catch {
      // Socket exists but not responding, try next
      continue;
    }
  }

  // Last resort: try default dockerode connection (DOCKER_HOST env or default socket)
  try {
    const docker = new Docker();
    const info = await docker.version();
    
    const isPodman = info.Components?.some(c => 
      c.Name.toLowerCase().includes('podman')
    ) ?? false;
    
    cachedRuntimeInfo = {
      type: isPodman ? 'podman' : 'docker',
      mode: 'rootful', // Assume rootful for default connection
      socketPath: '/var/run/docker.sock',
      version: info.Version,
    };
    cachedDocker = docker;
    return cachedRuntimeInfo;
  } catch {
    return null;
  }
}

/**
 * Get a configured Docker client instance
 * Uses cached instance if available
 * 
 * @throws Error if no container runtime is available
 */
export async function getDockerClient(): Promise<Docker> {
  if (cachedDocker) {
    return cachedDocker;
  }

  const runtimeInfo = await detectRuntime();
  if (!runtimeInfo || !cachedDocker) {
    throw new Error(
      'No container runtime detected. Please ensure Docker or Podman is installed and running.\n' +
      'For rootless operation (recommended):\n' +
      '  - Podman: podman machine start (macOS) or systemctl --user start podman.socket (Linux)\n' +
      '  - Docker: dockerd-rootless-setuptool.sh install (Linux)\n' +
      'For rootful operation:\n' +
      '  - Docker Desktop, Colima, Rancher Desktop, or system Docker/Podman service'
    );
  }

  return cachedDocker;
}

/**
 * Get cached runtime info without making network calls
 * Returns null if runtime has not been detected yet
 */
export function getCachedRuntimeInfo(): ContainerRuntimeInfo | null {
  return cachedRuntimeInfo;
}

/**
 * Clear the cached runtime instance
 * Useful for testing or reconnecting after configuration changes
 */
export function clearRuntimeCache(): void {
  cachedDocker = null;
  cachedRuntimeInfo = null;
}

/**
 * Check if a container runtime is available
 */
export async function isRuntimeAvailable(): Promise<boolean> {
  const info = await detectRuntime();
  return info !== null;
}
