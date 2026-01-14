# ArtiPod

A TypeScript library for managing AI-aware file storage with secure container execution. ArtiPod provides filesystem abstraction through mounts and isolated command execution via Docker containers.

## Overview

**ArtiPod** is a top-level container that aggregates multiple **ArtiMounts**, providing a unified interface for managing project files and generating AI context prompts.

**ArtiMount** is a named storage component representing a filesystem directory with operations for reading, writing, and listing files.

Look at [ozwell-artipod](https://github.com/mieweb/ozwell-artipod) to understand how to get an agent to work on an artipod.

## Features

### Filesystem Management
- **Multiple Mounts**: Aggregate multiple filesystem directories under a single pod
- **Read-only Mounts**: Create immutable mounts that prevent modifications
- **File Operations**: Read, write, and list files with path safety validation
- **README Integration**: Automatically extract README content from mounts
- **Line-based Reading**: Read specific line ranges from files
- **Directory Listings**: List files with sizes and directory structures

### AI Agent Tools (vscode-copilot-chat Compatible)
- **Identical Interfaces**: Tools match VS Code Copilot Chat schemas exactly
- **OpenAI Compatible**: Tool definitions work with function calling APIs
- **String Replacement**: Precise edits with context-based matching
- **Apply Patch**: Unified diff format with fuzzy context matching
- **Prompt Templates**: Pre-built system prompts optimized for models

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

// Create a writable mount
const mount = new ArtiMount('my-project', '/path/to/project');
await mount.initialize();

// Create a read-only mount (prevents write operations)
const readOnlyMount = new ArtiMount('docs', '/path/to/docs', true);
await readOnlyMount.initialize();

// Read a file
const content = await mount.read('src/index.ts');

// Read specific lines
const lines = await mount.read('config.json', 1, 10);

// Write a file (only works on writable mounts)
await mount.write('output.txt', 'Hello, World!');

// Create a folder (only works on writable mounts)
await mount.createFolder('new-directory');

// Read-only mounts will throw errors on write operations
try {
  await readOnlyMount.write('file.txt', 'content');
} catch (error) {
  // Error: "Cannot write to read-only mount 'docs'"
}

// List all files
const files = await mount.list();
// Returns: [{ path: 'src/index.ts', size: 1234 }, ...]

// Get README contents
const readmes = await mount.getReadmeContents();
```

### ArtiPod - Aggregating Mounts

```typescript
import { ArtiPod, ArtiMount } from '@mieweb/artipod';

// Create pod with automatic main mount (writable workspace)
const pod = new ArtiPod({ 
  workspaceDir: '/path/to/workspaces' 
});
await pod.initialize();

// The pod now has a "main" mount at /path/to/workspaces/artipod-{id}
const mainMount = pod.getMount('main');
console.log(pod.getId()); // e.g., "a1b2c3d4e5f6..."

// Create pod with custom ID (useful for persistence)
const pod2 = new ArtiPod({ 
  id: 'my-project-123',
  workspaceDir: '/path/to/workspaces' 
});
await pod2.initialize();
// Creates/reuses /path/to/workspaces/artipod-my-project-123

// IMPORTANT: For persistence, store all mounts (including main) in your database
// When re-instantiating, provide ALL mounts explicitly:
const mainMount = new ArtiMount('main', '/path/to/workspaces/artipod-my-project-123');
const docsMount = new ArtiMount('docs', '/path/to/docs');
const reloadedPod = new ArtiPod({
  id: 'my-project-123',
  useMainMount: false,  // Don't auto-create; providing explicitly
  mounts: [mainMount, docsMount]
});
await reloadedPod.initialize();
// useMainMount is only for initial creation - when reloading, provide all mounts

// Add additional mounts
const docs = new ArtiMount('docs', '/path/to/docs');
await docs.initialize();
pod2.addMount(docs);

// Create pod without automatic main mount
const pod3 = new ArtiPod({ useMainMount: false });
await pod3.initialize();
// No main mount created, can add your own mounts

// Create pod with initial mounts
const src = new ArtiMount('src', '/path/to/src');
const pod4 = new ArtiPod({
  workspaceDir: '/path/to/workspaces',
  mounts: [docs, src]  // Will be initialized automatically
});
await pod4.initialize();

// Clean up main mount when done
await pod.cleanupMainMount(); // Removes main mount and deletes directory

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

// Create pod with automatic main mount
const pod = new ArtiPod({ 
  workspaceDir: '/path/to/workspaces' 
});
await pod.initialize();

// Basic usage - just specify Dockerfile
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

### AI Agent Tools (vscode-copilot-chat Compatible)

ArtiPod includes two levels of tools with interfaces identical to VS Code Copilot Chat. This enables AI models trained on VS Code's tool schema to work seamlessly with artipod for file operations and container command execution.

#### Tool Registries: Mount-Level vs Pod-Level

**Mount-Level Tools** (`MountToolRegistry`) - File operations on a single mount:
- Operate on individual ArtiMount instances
- Provide file reading, editing, and directory operations
- All file paths are relative to the mount's root directory

**Pod-Level Tools** (`PodToolRegistry`) - Container operations across the pod:
- Operate on ArtiPod instances (across all mounts)
- Provide command execution in sandboxed containers
- Access all mounts at `/context/<mount-name>` in the container

```typescript
import { ArtiMount, ArtiPod, MountToolRegistry, PodToolRegistry } from '@mieweb/artipod';

// Create mount-level tool registry for file operations
const mount = new ArtiMount('project', '/path/to/files');
await mount.initialize();
const mountTools = new MountToolRegistry(mount);

// Create pod-level tool registry for container operations
const pod = new ArtiPod({ workspaceDir: '/path/to/workspace' });
await pod.initialize();
const podTools = new PodToolRegistry(pod);

// Get OpenAI function-calling compatible definitions
const allDefinitions = [
  ...mountTools.getDefinitions(),
  ...podTools.getDefinitions()
];

// Execute mount-level tool
const readResult = await mountTools.execute('read_file', {
  filePath: 'README.md',
  startLine: 1,
  endLine: 50
});

// Execute pod-level tool (requires container to be started)
await pod.startContainer();
const cmdResult = await podTools.execute('run_in_terminal', {
  command: 'ls -la /context/main',
  timeout: 5000  // Optional timeout override
});
```

#### Mount-Level Tools

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents with line range support (v1: startLine/endLine, v2: offset/limit) |
| `create_file` | Create new files with automatic directory creation |
| `list_dir` | List directory contents with folder indicators |
| `create_directory` | Create directories recursively (like `mkdir -p`) |
| `replace_string_in_file` | Replace exact string matches with uniqueness validation |
| `multi_replace_string_in_file` | Batch replacements across one or more files |
| `apply_patch` | Apply unified diff-style patches with fuzzy context matching |

#### Pod-Level Tools

| Tool | Description |
|------|-------------|
| `run_in_terminal` | Execute bash commands in a sandboxed container environment |

**Container Environment:**
- **Working directory:** `/context` (all mounts accessible at `/context/<mount-name>`)
- **Default timeout:** 30 seconds (configurable per-pod)
- **Maximum timeout:** 5 minutes per command
- **Resource limits:** 512MB memory, 1 CPU core, 100 process limit
- **Security:** seccomp sandbox, no new privileges, minimal capabilities
- **User:** Unprivileged `artipod` user (UID 1000)
- **Exit code:** Success when `exitCode === 0`, failure otherwise

**Example:**
```typescript
await pod.startContainer();

// Simple command
const result = await podTools.execute('run_in_terminal', {
  command: 'echo "Hello World"'
});

// Change directory
const result2 = await podTools.execute('run_in_terminal', {
  command: 'cd /context/main && pwd'
});

// With timeout override
const result3 = await podTools.execute('run_in_terminal', {
  command: 'npm install',
  timeout: 120000  // 2 minutes
});
```

#### Using apply_patch

The `apply_patch` tool supports a structured patch format for complex edits:

```typescript
const patchResult = await tools.execute('apply_patch', {
  input: `*** Begin Patch
*** Update File: /path/to/files/example.md
@@ ## Section Header
 context line before
-old line to remove
+new line to add
 context line after
*** End Patch`,
  explanation: 'Update example section'
});
```

#### System Prompt Templates

Generate optimized system prompts for AI agents using the extracted vscode-copilot-chat instructions:

```typescript
import { buildSystemPrompt } from '@mieweb/artipod';

const systemPrompt = buildSystemPrompt({
  includeReplaceString: true,      // Include replace_string instructions
  includeApplyPatch: true,         // Include apply_patch format docs
  includeMarkdownInstructions: true, // Markdown-specific tips
  workspaceRoot: '/path/to/files',  // For absolute path context
  customInstructions: 'Focus on editing markdown documentation files.'
});

// Use systemPrompt with your AI model
```

Individual instruction constants are also available:

```typescript
import { 
  AGENT_INSTRUCTIONS,
  TOOL_USE_INSTRUCTIONS, 
  REPLACE_STRING_INSTRUCTIONS,
  APPLY_PATCH_INSTRUCTIONS,
  MARKDOWN_EDITING_INSTRUCTIONS 
} from '@mieweb/artipod';
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

- `constructor(name: string, rootPath: string, readonly?: boolean)` - Create a mount (optionally read-only, default: false)
- `initialize(): Promise<void>` - Verify mount exists
- `getName(): string` - Get mount name
- `getRootPath(): string` - Get mount root path
- `isReadOnly(): boolean` - Check if mount is read-only
- `read(path: string, startLine?: number, endLine?: number): Promise<string>` - Read file
- `write(path: string, content: string | Buffer): Promise<void>` - Write file (throws on read-only mounts)
- `createFolder(path: string): Promise<void>` - Create directory (throws on read-only mounts)
- `list(path?: string): Promise<FileInfo[]>` - List files
- `listWithDirectories(path?: string): Promise<EntryInfo[]>` - List files and directories
- `getReadmeContents(): Promise<string[]>` - Get README files

### ArtiPod

- `constructor(options?: ArtiPodOptions)` - Create a pod with optional configuration
  - `id?: string` - Custom pod ID (auto-generated if not provided)
  - `workspaceDir?: string` - Directory for main mount (required if useMainMount is true)
  - `useMainMount?: boolean` - Auto-create main mount (default: true)
  - `mounts?: ArtiMount[]` - Initial mounts to add
- `initialize(): Promise<void>` - Initialize pod and all mounts (idempotent)
- `getId(): string` - Get pod's unique identifier
- `cleanupMainMount(): Promise<void>` - Remove main mount and delete its directory
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

### ToolRegistry

- `constructor(mount: ArtiMount)` - Create registry with all tools for a mount
- `register(tool: ToolHandler): void` - Register a custom tool
- `get(name: ToolName | string): ToolHandler | undefined` - Get tool by name
- `getAll(): ToolHandler[]` - Get all registered tools
- `getDefinitions(): ToolDefinition[]` - Get OpenAI-compatible definitions
- `execute(name: ToolName | string, params: unknown): Promise<ToolResult>` - Execute a tool
- `has(name: ToolName | string): boolean` - Check if tool exists

### Tool Factory Functions

- `createToolRegistry(mount: ArtiMount): ToolRegistry` - Create full registry
- `createAllTools(mount: ArtiMount): ToolHandler[]` - Create array of handlers
- `createCoreTools(mount: ArtiMount): ToolHandler[]` - Create read/write/list tools
- `createEditTools(mount: ArtiMount): ToolHandler[]` - Create replace string tools
- `createApplyPatchTool(mount: ArtiMount): ApplyPatchTool` - Create patch tool

### Prompt Builders

- `buildSystemPrompt(options?: SystemPromptOptions): string` - Build complete system prompt
- `buildReminderPrompt(options?): string` - Build editing reminder

### Types

```typescript
interface ArtiPodOptions {
  id?: string;                      // Unique pod ID (auto-generated if not provided)
  workspaceDir?: string;            // Base directory for workspaces (required if useMainMount is true)
  useMainMount?: boolean;         // Auto-create writable 'main' mount (default: true)
  mounts?: ArtiMount[];             // Initial mounts to add to the pod
}

interface BuildPromptOptions {
  maxSize?: number;                 // Max characters in prompt
  includeFiles?: boolean;           // Include file listings
  maxFilesPerMount?: number;        // Max files per mount
}

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

// Tool Types
enum ToolName {
  ReadFile = 'read_file',
  CreateFile = 'create_file',
  ListDirectory = 'list_dir',
  CreateDirectory = 'create_directory',
  ReplaceString = 'replace_string_in_file',
  MultiReplaceString = 'multi_replace_string_in_file',
  ApplyPatch = 'apply_patch',
}

interface ToolResult {
  success: boolean;
  content?: string;
  error?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    required: string[];
    properties: Record<string, { type: string; description: string }>;
  };
}

interface SystemPromptOptions {
  includeReplaceString?: boolean;
  includeApplyPatch?: boolean;
  includeMarkdownInstructions?: boolean;
  workspaceRoot?: string;
  customInstructions?: string;
}
```

## License

MIT

