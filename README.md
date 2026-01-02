# ArtiPod

A TypeScript library for managing AI-aware file storage with secure container execution. ArtiPod provides filesystem abstraction through mounts and isolated command execution via Docker containers.

## Overview

**ArtiPod** is a top-level container that aggregates multiple **ArtiMounts**, providing a unified interface for managing project files and generating AI context prompts.

**ArtiMount** is a named storage component representing a filesystem directory with operations for reading, writing, and listing files.

## Features

### Filesystem Management
- **Multiple Mounts**: Aggregate multiple filesystem directories under a single pod
- **File Operations**: Read, write, and list files with path safety validation
- **README Integration**: Automatically extract README content from mounts
- **Line-based Reading**: Read specific line ranges from files
- **Directory Listings**: List files with sizes and directory structures

### AI Context Generation
- **Prompt Building**: Generate XML-formatted prompts from all mounts in the pod
- **README Aggregation**: Collect README files from all mounts
- **File Trees**: Format file listings as hierarchical trees with size information
- **Smart Truncation**: Intelligently truncate large directories and limit file counts
- **Size Limiting**: Optional max size truncation and per-mount file count limits

## Installation

```bash
npm install @mieweb/artipod
```

## Usage

### Basic ArtiMount Operations

```typescript
import { ArtiMount } from '@mieweb/artipod';

// Create a mount
const mount = new ArtiMount('my-project', '/path/to/project');
await mount.initialize();

// Read a file
const content = await mount.read('src/index.ts');

// Read specific lines
const lines = await mount.read('config.json', 1, 10);

// Write a file
await mount.write('output.txt', 'Hello, World!');

// Create a folder
await mount.createFolder('new-directory');

// List all files
const files = await mount.list();
// Returns: [{ path: 'src/index.ts', size: 1234 }, ...]

// Get README contents
const readmes = await mount.getReadmeContents();
```

### ArtiPod - Aggregating Mounts

```typescript
import { ArtiPod, ArtiMount } from 'artipod';

// Create mounts
const docs = new ArtiMount('docs', '/path/to/docs');
const src = new ArtiMount('src', '/path/to/src');

// Create pod with mounts
const pod = new ArtiPod([docs, src]);

// Or add mounts later
const pod2 = new ArtiPod();
pod2.addMount(docs);
pod2.addMount(src);

// Build AI context prompt from all mounts in the pod
const prompt = await pod.buildPrompt({
  maxSize: 50000,                 // Optional: max characters
  includeFiles: true,             // Optional: include file listings
  maxFilesPerMount: 100           // Optional: max files per mount
});

// Result is XML-formatted:
// <context>
// <dataSource>
// <name>docs</name>
// <readme>
// ... README content ...
// </readme>
// <files>
// README.md (2.3 KB)
// guide.md (5.1 KB)
// examples/
//   example1.md (1.2 KB)
//   ...
// </files>
// </dataSource>
// ...
// </context>
```

### Container Execution

ArtiPod provides secure, isolated container execution with automatic runtime detection. It supports both **Docker** and **Podman**, preferring rootless configurations for improved security:

```typescript
import { ArtiPod, ArtiMount, detectRuntime } from '@mieweb/artipod';

// Check available runtime (optional)
const runtime = await detectRuntime();
if (runtime) {
  console.log(`Using ${runtime.type} (${runtime.mode})`);
  // e.g., "Using podman (rootless)" or "Using docker (rootful)"
}

// Create pod with mounts
const docs = new ArtiMount('docs', '/path/to/docs');
const src = new ArtiMount('src', '/path/to/src');
const pod = new ArtiPod([docs, src]);

// Basic usage - just specify Dockerfile, use all defaults
await pod.startContainer('/path/to/Dockerfile');

// Execute commands
const result = await pod.executeCommand('ls -la /context');
console.log(result.stdout);
console.log(result.exitCode);

// Stop container
await pod.stopContainer();
```

**Advanced usage** - Override defaults with custom options:

```typescript
// Start container with custom configuration
await pod.startContainer('/path/to/Dockerfile', {
  seccompProfilePath: '/path/to/seccomp.json',  // Optional syscall filtering
  labels: { project: 'myproject', env: 'prod' }, // Custom container labels
  enableNetwork: true,                           // Enable network access
  commandTimeout: 60000,                         // 60 second timeout
  memory: 1024 * 1024 * 1024,                   // 1GB memory limit
  memorySwap: 1024 * 1024 * 1024,               // 1GB memory+swap (no swap)
  nanoCpus: 2000000000,                          // 2 CPU cores
  pidsLimit: 200,                                // Max 200 processes
  tmpfs: {                                       // Custom tmpfs mounts
    '/tmp': 'rw,noexec,nosuid,size=200m',
    '/var/tmp': 'rw,noexec,nosuid,size=200m',
  },
});

// Check container status
if (pod.hasContainer()) {
  console.log('Container ID:', pod.getContainerId());
}
```

### Application-Level Container Management

Applications can discover and clean up containers using utility functions:

```typescript
import { findAllContainers, removeContainer } from '@mieweb/artipod';

// Find all artipod-managed containers
const containers = await findAllContainers();

// Find containers with specific labels
const projectContainers = await findAllContainers({ project: 'myproject' });

// Clean up a specific container
for (const container of containers) {
  const info = await container.inspect();
  console.log('Found container:', info.Id);
  
  // Remove if orphaned or no longer needed
  await removeContainer(container);
}
```

### Runtime Detection

ArtiPod automatically detects and uses the available container runtime, with preference for rootless configurations:

**Detection Priority (first available wins):**

1. **Podman rootless** - `$XDG_RUNTIME_DIR/podman/podman.sock`
2. **Docker rootless** - `$XDG_RUNTIME_DIR/docker.sock`
3. **Docker Desktop (macOS)** - `~/.docker/run/docker.sock`
4. **Colima (macOS)** - `~/.colima/default/docker.sock`
5. **Lima (macOS)** - `~/.lima/default/sock/docker.sock`
6. **Rancher Desktop (macOS)** - `~/.rd/docker.sock`
7. **Podman Machine (macOS)** - `~/.local/share/containers/podman/machine/podman.sock`
8. **Podman rootful** - `/run/podman/podman.sock`
9. **Docker rootful** - `/var/run/docker.sock`

The `DOCKER_HOST` environment variable is checked first and takes precedence if set.

```typescript
import { detectRuntime, isRuntimeAvailable, getCachedRuntimeInfo } from '@mieweb/artipod';

// Check if any runtime is available
if (await isRuntimeAvailable()) {
  const info = await detectRuntime();
  console.log(`Runtime: ${info.type}`);     // 'docker' or 'podman'
  console.log(`Mode: ${info.mode}`);         // 'rootless' or 'rootful'
  console.log(`Socket: ${info.socketPath}`);
  console.log(`Version: ${info.version}`);
}
```

## Development

### Prerequisites

- Node.js >= 18.0.0
- Docker or Podman (for container features)
  - **Recommended:** Podman or Docker in rootless mode
  - Docker Desktop, Colima, Rancher Desktop, or Lima also work

### Install Dependencies


```bash
npm install
```

### Build

```bash
npm run build
```

### Test

```bash
npm test
npm run test:watch
npm run test:coverage
```

### Lint

```bash
npm run lint
npm run lint:fix
```

## Examples

A full-stack web demo showcasing:
- Filesystem management UI
- Pod and mount creation
- File browsing and editing
- Container management
- Interactive command execution

See the [web demo example](https://github.com/mieweb/artipod/tree/main/examples/web-demo) for setup instructions.

## Security

ArtiPod containers are hardened with multiple security layers:

- **Seccomp Profile**: Allowlist-based syscall filtering (optional)
- **Read-only Filesystem**: Root filesystem is read-only
- **Resource Limits**: Configurable CPU, Memory, and PID limits (defaults: 1 core, 512MB, 100 PIDs)
- **Network Isolation**: No network access by default
- **Unprivileged User**: Runs as non-root `artipod` user
- **No Capabilities**: All Linux capabilities dropped
- **IPC Isolation**: Private IPC namespace
- **Tmpfs Configuration**: Configurable tmpfs mounts for writable directories

Blocked syscalls include: kernel module loading, system reboot, filesystem mounting, hardware access, and more. See the [seccomp profiles documentation](https://github.com/mieweb/artipod/tree/main/container/seccomp-profiles) for details.

Each pod can use a different Dockerfile and seccomp profile, allowing per-pod customization of the execution environment.

## API Reference

### ArtiMount

- `constructor(name: string, rootPath: string)`
- `initialize(): Promise<void>` - Verify mount exists
- `getName(): string` - Get mount name
- `getRootPath(): string` - Get mount root path
- `read(path: string, startLine?: number, endLine?: number): Promise<string>` - Read file
- `write(path: string, content: string | Buffer): Promise<void>` - Write file
- `createFolder(path: string): Promise<void>` - Create directory
- `list(path?: string): Promise<FileInfo[]>` - List files
- `listWithDirectories(path?: string): Promise<EntryInfo[]>` - List files and directories
- `getReadmeContents(): Promise<string[]>` - Get README files

### ArtiPod

- `constructor(mounts?: ArtiMount[])`
- `addMount(mount: ArtiMount): void` - Add mount to pod
- `removeMount(name: string): boolean` - Remove mount
- `getMount(name: string): ArtiMount | undefined` - Get mount by name
- `getMounts(): ArtiMount[]` - Get all mounts
- `getMountNames(): string[]` - Get mount names
- `buildPrompt(options?: BuildPromptOptions): Promise<string>` - Generate AI context
- `startContainer(dockerfilePath: string, options?: ContainerOptions): Promise<ContainerHandle>` - Start sandboxed container
- `stopContainer(): Promise<void>` - Stop and remove container
- `executeCommand(command: string): Promise<CommandResult>` - Execute bash command in container
- `hasContainer(): boolean` - Check if container is running
- `getContainerId(): string | undefined` - Get container ID

### Container Utilities

- `findAllContainers(labelFilters?: Record<string, string>, labelPrefix?: string): Promise<ContainerHandle[]>` - Find all artipod-managed containers
- `removeContainer(container: ContainerHandle): Promise<void>` - Stop and remove a container

### Runtime Detection

- `detectRuntime(): Promise<ContainerRuntimeInfo | null>` - Detect available container runtime
- `isRuntimeAvailable(): Promise<boolean>` - Check if any runtime is available
- `getCachedRuntimeInfo(): ContainerRuntimeInfo | null` - Get cached runtime info (no async)
- `clearRuntimeCache(): void` - Clear cached runtime (for reconnection)

### Types

```typescript
interface ContainerOptions {
  seccompProfilePath?: string;     // Path to seccomp profile
  enableNetwork?: boolean;          // Enable network (default: false)
  commandTimeout?: number;          // Timeout in ms (default: 30000)
  labelPrefix?: string;             // Label prefix (default: 'artipod')
  labels?: Record<string, string>;  // Custom container labels
  memory?: number;                  // Memory limit in bytes (default: 512MB)
  memorySwap?: number;              // Memory+swap limit (default: same as memory)
  nanoCpus?: number;                // CPU limit in nano CPUs (default: 1e9)
  pidsLimit?: number;               // Max processes (default: 100)
  tmpfs?: Record<string, string>;   // Tmpfs mounts (default: /tmp and /var/tmp)
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  modifiedFiles?: string[];
}

interface ContainerRuntimeInfo {
  type: 'docker' | 'podman';        // Detected runtime type
  mode: 'rootless' | 'rootful';     // Privilege mode
  socketPath: string;               // Socket path being used
  version?: string;                 // Runtime version
}
```

## License

MIT

