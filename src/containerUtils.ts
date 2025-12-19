import Docker from 'dockerode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

/**
 * Handle to a running container instance
 */
export type ContainerHandle = Docker.Container;

/**
 * Result from executing a command in the container
 */
export interface CommandResult {
  /** Standard output from the command */
  stdout: string;
  
  /** Standard error from the command */
  stderr: string;
  
  /** Exit code from the command */
  exitCode: number;
  
  /** Optional list of files modified during command execution */
  modifiedFiles?: string[];
}

/**
 * Options for container creation
 */
export interface ContainerOptions {
  /** Path to seccomp profile for syscall filtering */
  seccompProfilePath?: string;
  
  /** Enable network access in containers (default: false) */
  enableNetwork?: boolean;
  
  /** Command execution timeout in milliseconds (default: 30000) */
  commandTimeout?: number;
  
  /** Label prefix for tagging containers (default: 'artipod') */
  labelPrefix?: string;
  
  /** Custom labels to tag the container with (without prefix) */
  labels?: Record<string, string>;
  
  /** Memory limit in bytes (default: 512MB) */
  memory?: number;
  
  /** Memory + swap limit in bytes (default: same as memory, no swap) */
  memorySwap?: number;
  
  /** CPU limit in nano CPUs (default: 1e9 = 1 core) */
  nanoCpus?: number;
  
  /** Maximum number of processes (default: 100) */
  pidsLimit?: number;
  
  /** Tmpfs mounts (default: /tmp and /var/tmp with 100m each) */
  tmpfs?: Record<string, string>;
}

/**
 * Hash Dockerfile contents to generate a unique image name
 */
function hashDockerfile(dockerfilePath: string): string {
  const content = fs.readFileSync(dockerfilePath, 'utf-8');
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  return hash.substring(0, 12);
}

/**
 * Build Docker image from Dockerfile
 * Uses hash-based naming to automatically reuse images with identical Dockerfiles
 */
async function buildContainerImage(dockerfilePath: string, imageName?: string): Promise<string> {
  const docker = new Docker();
  const finalImageName = imageName || `artipod:${hashDockerfile(dockerfilePath)}`;
  
  // Check if image already exists
  try {
    await docker.getImage(finalImageName).inspect();
    return finalImageName;
  } catch {
    // Image doesn't exist, build it
    const stream = await docker.buildImage(
      {
        context: path.dirname(dockerfilePath),
        src: [path.basename(dockerfilePath)],
      },
      {
        t: finalImageName,
      }
    );

    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err, res) => 
        err ? reject(err) : resolve(res)
      );
    });
    
    return finalImageName;
  }
}

/**
 * Create and start a new container
 */
async function createContainer(
  imageName: string,
  mounts: string[],
  options?: ContainerOptions
): Promise<ContainerHandle> {
  const docker = new Docker();
  
  // Apply defaults
  const labelPrefix = options?.labelPrefix || 'artipod';
  const enableNetwork = options?.enableNetwork ?? false;
  const memory = options?.memory || 512 * 1024 * 1024; // 512MB
  const memorySwap = options?.memorySwap ?? memory; // No swap by default
  const nanoCpus = options?.nanoCpus || 1000000000; // 1 CPU core
  const pidsLimit = options?.pidsLimit || 100;
  const tmpfs = options?.tmpfs || {
    '/tmp': 'rw,noexec,nosuid,size=100m',
    '/var/tmp': 'rw,noexec,nosuid,size=100m',
  };
  
  // Build labels with prefix
  const containerLabels: Record<string, string> = {
    [`${labelPrefix}.managed`]: 'true',
    [`${labelPrefix}.created_at`]: new Date().toISOString(),
  };
  
  // Add custom labels with prefix
  if (options?.labels) {
    for (const [key, value] of Object.entries(options.labels)) {
      containerLabels[`${labelPrefix}.${key}`] = value;
    }
  }
  
  // Load seccomp profile if provided
  const securityOpt = ['no-new-privileges'];
  if (options?.seccompProfilePath) {
    const seccompProfile = JSON.parse(fs.readFileSync(options.seccompProfilePath, 'utf-8'));
    securityOpt.push(`seccomp=${JSON.stringify(seccompProfile)}`);
  }
  
  const container = await docker.createContainer({
    Image: imageName,
    Cmd: ['/bin/bash', '-c', 'while true; do sleep 1; done'],
    Labels: containerLabels,
    HostConfig: {
      // Network isolation
      NetworkMode: enableNetwork ? 'bridge' : 'none',
      
      // Filesystem
      Binds: mounts,
      ReadonlyRootfs: true,
      Tmpfs: tmpfs,
      
      // Resource limits
      Memory: memory,
      MemorySwap: memorySwap,
      NanoCpus: nanoCpus,
      PidsLimit: pidsLimit,
      
      // Security options
      CapDrop: ['ALL'],
      SecurityOpt: securityOpt,
      Privileged: false,
      
      // IPC isolation
      IpcMode: 'private',
      
      // Cleanup
      AutoRemove: false,
    },
    WorkingDir: '/context',
    User: 'artipod',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  await container.start();
  return container;
}

/**
 * Execute a bash command inside the container
 */
async function executeCommandInContainer(
  container: ContainerHandle,
  command: string,
  timeout: number = 30000
): Promise<CommandResult> {
  const docker = new Docker();
  
  const exec = await container.exec({
    Cmd: ['/bin/bash', '-c', command],
    AttachStdout: true,
    AttachStderr: true,
    User: 'artipod',
  });

  const stream = await exec.start({ Detach: false });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timeoutId: NodeJS.Timeout | null = null;
  let timedOut = false;

  // Create simple writable streams for demuxing
  const stdoutStream = {
    write: (chunk: Buffer) => {
      stdout.push(chunk);
      return true;
    },
    end: () => {},
  };

  const stderrStream = {
    write: (chunk: Buffer) => {
      stderr.push(chunk);
      return true;
    },
    end: () => {},
  };

  // Set up timeout
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      stream.destroy();
      reject(new Error(`Command execution timed out after ${timeout}ms`));
    }, timeout);
  });

  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        docker.modem.demuxStream(
          stream,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stdoutStream as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stderrStream as any
        );

        stream.on('end', () => resolve());
        stream.on('error', (err) => reject(err));
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }

  const inspectData = await exec.inspect();
  const exitCode = timedOut ? 124 : (inspectData.ExitCode || 0);

  return {
    stdout: Buffer.concat(stdout).toString('utf-8'),
    stderr: timedOut 
      ? `Command timed out after ${timeout}ms\n` + Buffer.concat(stderr).toString('utf-8')
      : Buffer.concat(stderr).toString('utf-8'),
    exitCode,
  };
}

/**
 * Stop and remove a container
 */
async function stopAndRemoveContainer(container: ContainerHandle): Promise<void> {
  try {
    await container.stop({ t: 2 });
  } catch (err) {
    // Container may already be stopped or not exist
    const message = (err as Error).message || '';
    if (
      !message.includes('is not running') &&
      !message.includes('304') &&
      !message.includes('no such container') &&
      !message.includes('404')
    ) {
      throw err;
    }
  }

  try {
    await container.remove({ force: true });
  } catch (err) {
    // Container may already be removed
    const message = (err as Error).message || '';
    if (!message.includes('no such container') && !message.includes('404')) {
      throw err;
    }
  }
}

/**
 * Get container information including labels
 */
async function getContainerInfo(container: ContainerHandle): Promise<Docker.ContainerInspectInfo> {
  return await container.inspect();
}

// ============================================================================
// PUBLIC API - Available to applications
// ============================================================================

/**
 * Find all artipod-managed containers based on label filters
 * @param labelFilters - Optional label filters (key-value pairs, without prefix)
 * @param labelPrefix - Label prefix to use (default: 'artipod')
 * @returns Array of container handles
 */
export async function findAllContainers(
  labelFilters?: Record<string, string>,
  labelPrefix: string = 'artipod'
): Promise<ContainerHandle[]> {
  const docker = new Docker();
  
  // Build filter with prefix
  const filters: Record<string, string[]> = {
    label: [`${labelPrefix}.managed=true`],
  };
  
  // Add custom label filters with prefix
  if (labelFilters) {
    for (const [key, value] of Object.entries(labelFilters)) {
      filters.label.push(`${labelPrefix}.${key}=${value}`);
    }
  }
  
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify(filters),
  });
  
  return containers.map(info => docker.getContainer(info.Id));
}

/**
 * Remove a single container
 * @param container - Container handle to remove
 */
export async function removeContainer(container: ContainerHandle): Promise<void> {
  await stopAndRemoveContainer(container);
}

// Export internal functions for use by ArtiPod
export {
  buildContainerImage,
  createContainer,
  executeCommandInContainer,
  stopAndRemoveContainer,
  getContainerInfo,
};
