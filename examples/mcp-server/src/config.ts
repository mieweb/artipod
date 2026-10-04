import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
config();

export interface ServerConfig {
  workspaceDir: string;
  podId?: string;
  dockerfilePath: string;
  seccompProfilePath: string;
  containerMemoryMB: number;
  containerCpuCount: number;
  commandTimeoutMs: number;
}

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getOptionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export function loadConfig(): ServerConfig {
  const workspaceDir = getRequiredEnv('WORKSPACE_DIR');
  const podId = process.env.POD_ID;
  
  // Resolve paths relative to project root
  const projectRoot = resolve(__dirname, '../../..');
  const dockerfilePath = resolve(
    projectRoot,
    getOptionalEnv('DOCKERFILE_PATH', 'container/Dockerfile')
  );
  const seccompProfilePath = resolve(
    projectRoot,
    getOptionalEnv('SECCOMP_PROFILE_PATH', 'container/seccomp-profiles/sandbox.json')
  );

  const containerMemoryMB = parseInt(
    getOptionalEnv('CONTAINER_MEMORY_MB', '512'),
    10
  );
  const containerCpuCount = parseInt(
    getOptionalEnv('CONTAINER_CPU_COUNT', '1'),
    10
  );
  const commandTimeoutMs = parseInt(
    getOptionalEnv('COMMAND_TIMEOUT_MS', '30000'),
    10
  );

  return {
    workspaceDir,
    podId,
    dockerfilePath,
    seccompProfilePath,
    containerMemoryMB,
    containerCpuCount,
    commandTimeoutMs,
  };
}
