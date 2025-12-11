import express, { Request, Response } from 'express';
import cors from 'cors';
import * as fs from 'fs/promises';
import * as path from 'path';
import { nanoid } from 'nanoid';
import * as db from './database';
import { podManager } from './podManager';

const app = express();
const PORT = 3001;
const WORKSPACE_ROOT = path.join(__dirname, '../../workspace/files');
const DOCKERFILE_PATH = path.join(__dirname, '../../../../container/Dockerfile');
const SECCOMP_PROFILE_PATH = path.join(__dirname, '../../../../container/seccomp-profiles/sandbox.json');

app.use(cors());
app.use(express.json());

// Ensure workspace exists
(async () => {
  await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
})();

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Helper function to ensure pod is loaded with mounts
async function ensurePodFullyLoaded(podId: string): Promise<void> {
  const mounts = db.getMountsForPod.all(podId);
  const container = db.getContainerForPod.get(podId) as db.Container | undefined;
  await podManager.ensurePodLoaded(podId, mounts as db.Mount[], container);
}


// Filesystem operations
app.post('/api/fs/folder', async (req: Request, res: Response) => {
  try {
    const { path: folderPath } = req.body;
    if (!folderPath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    const fullPath = path.join(WORKSPACE_ROOT, folderPath);
    await fs.mkdir(fullPath, { recursive: true });
    
    res.json({ success: true, path: folderPath });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/fs/file', async (req: Request, res: Response) => {
  try {
    const { path: filePath, content = '' } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'Path is required' });
    }

    const fullPath = path.join(WORKSPACE_ROOT, filePath);
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    
    res.json({ success: true, path: filePath });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/fs/tree', async (_req: Request, res: Response) => {
  try {
    const tree = await buildFileTree(WORKSPACE_ROOT);
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/fs/file/*', async (req: Request, res: Response) => {
  try {
    const filePath = req.params[0];
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }

    const fullPath = path.join(WORKSPACE_ROOT, filePath);
    
    // Security check: ensure the path is within workspace
    const resolvedPath = path.resolve(fullPath);
    const resolvedWorkspace = path.resolve(WORKSPACE_ROOT);
    if (!resolvedPath.startsWith(resolvedWorkspace)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if file exists
    try {
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        return res.status(400).json({ error: 'Path is a directory' });
      }
    } catch (error) {
      return res.status(404).json({ error: 'File not found' });
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    
    res.json({ content, path: filePath });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Pod operations
app.get('/api/pods', (_req: Request, res: Response) => {
  try {
    const pods = db.getAllPods.all();
    const podsWithDetails = pods.map((pod: any) => {
      const mounts = db.getMountsForPod.all(pod.id);
      const containerData = db.getContainerForPod.get(pod.id) as db.Container | undefined;
      const hasContainer = podManager.hasContainer(pod.id);
      const container = hasContainer ? {
        status: 'running',
        container_id: podManager.getContainerId(pod.id),
        last_command_at: containerData?.last_command_at,
        command_count: containerData?.command_count || 0
      } : null;
      return { ...pod, mounts, container };
    });
    res.json(podsWithDetails);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/pods', async (req: Request, res: Response) => {
  try {
    const { name, mounts = [] } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    const id = nanoid(10);
    const now = Date.now();
    
    db.createPod.run(id, name, now);
    await podManager.createPod(id);

    // Add mounts if provided
    for (const mount of mounts) {
      db.createMount.run(id, mount.name, mount.path);
      await podManager.addMount(id, mount.name, mount.path);
    }

    const pod = db.getPod.get(id);
    res.json(pod);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/pods/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const pod = db.getPod.get(id);
    
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const mounts = db.getMountsForPod.all(id);
    const containerData = db.getContainerForPod.get(id) as db.Container | undefined;
    
    // Return actual container status from podManager, not stale DB status
    const hasContainer = podManager.hasContainer(id);
    const container = hasContainer ? {
      status: 'running',
      container_id: podManager.getContainerId(id),
      last_command_at: containerData?.last_command_at,
      command_count: containerData?.command_count || 0
    } : null;

    res.json({ ...pod, mounts, container });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.delete('/api/pods/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Stop container if running
    if (podManager.hasContainer(id)) {
      await podManager.stopContainer(id);
    }

    db.deletePod.run(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Get prompt for a pod
app.get('/api/pods/:id/prompt', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Ensure pod is loaded
    const podData = db.getPod.get(id);
    if (!podData) {
      return res.status(404).json({ error: 'Pod not found' });
    }
    await ensurePodFullyLoaded(id);

    const pod = podManager.getPod(id);
    if (!pod) {
      return res.status(404).json({ error: 'Pod not found in manager' });
    }

    const prompt = await pod.buildPrompt();
    res.json({ prompt });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Mount operations
app.post('/api/pods/:id/mounts', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, path: mountPath } = req.body;

    if (!name || !mountPath) {
      return res.status(400).json({ error: 'Name and path are required' });
    }

    const podData = db.getPod.get(id);
    if (!podData) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    // Ensure pod is loaded with existing mounts and container before adding new one
    await ensurePodFullyLoaded(id);

    db.createMount.run(id, name, mountPath);
    await podManager.addMount(id, name, mountPath);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// File operations within mounts
app.get('/api/pods/:id/files', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Get pod and mounts from database
    const podData = db.getPod.get(id);
    if (!podData) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    const mounts = db.getMountsForPod.all(id);
    
    // Ensure pod is loaded in memory
    await ensurePodFullyLoaded(id);

    const filesByMount: Record<string, any[]> = {};

    for (const mount of mounts as db.Mount[]) {
      const artiMount = podManager.getMount(id, mount.mount_name);
      if (artiMount) {
        const entries = await artiMount.listWithDirectories();
        filesByMount[mount.mount_name] = entries;
      }
    }

    res.json(filesByMount);
  } catch (error) {
    console.error('Error in GET /api/pods/:id/files:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/pods/:id/files', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { mountName, filePath, content } = req.body;

    if (!mountName || !filePath) {
      return res.status(400).json({ error: 'Mount name and file path are required' });
    }

    // Ensure pod is loaded
    const podData = db.getPod.get(id);
    if (!podData) {
      return res.status(404).json({ error: 'Pod not found' });
    }
    await ensurePodFullyLoaded(id);

    const mount = podManager.getMount(id, mountName);
    if (!mount) {
      return res.status(404).json({ error: 'Mount not found' });
    }

    await mount.write(filePath, content || '');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/pods/:id/folders', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { mountName, folderPath } = req.body;

    if (!mountName || !folderPath) {
      return res.status(400).json({ error: 'Mount name and folder path are required' });
    }

    // Ensure pod is loaded
    const podData = db.getPod.get(id);
    if (!podData) {
      return res.status(404).json({ error: 'Pod not found' });
    }
    await ensurePodFullyLoaded(id);

    const mount = podManager.getMount(id, mountName);
    if (!mount) {
      return res.status(404).json({ error: 'Mount not found' });
    }

    await mount.createFolder(folderPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get('/api/pods/:id/files/:mountName/*', async (req: Request, res: Response) => {
  try {
    const { id, mountName } = req.params;
    const filePath = req.params[0];
    const startLine = req.query.startLine ? parseInt(req.query.startLine as string, 10) : undefined;
    const endLine = req.query.endLine ? parseInt(req.query.endLine as string, 10) : undefined;

    // Ensure pod is loaded
    const podData = db.getPod.get(id);
    if (!podData) {
      return res.status(404).json({ error: 'Pod not found' });
    }
    await ensurePodFullyLoaded(id);

    const mount = podManager.getMount(id, mountName);
    if (!mount) {
      return res.status(404).json({ error: 'Mount not found' });
    }

    const content = await mount.read(filePath, startLine, endLine);

    res.json({ content, path: filePath, startLine, endLine });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Container operations
app.post('/api/pods/:id/container/start', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const podData = db.getPod.get(id);
    if (!podData) {
      return res.status(404).json({ error: 'Pod not found' });
    }

    // Ensure pod is loaded with all mounts
    await ensurePodFullyLoaded(id);

    const container = await podManager.startContainer(id, DOCKERFILE_PATH, SECCOMP_PROFILE_PATH);
    const now = Date.now();

    // Check if container record already exists
    const existingContainer = db.getContainerForPod.get(id);
    if (existingContainer) {
      // Update existing container record
      db.deleteContainer.run(id);
    }
    
    db.createContainer.run(id, container.id, 'running', now);

    res.json({ success: true, containerId: container.id });
  } catch (error) {
    console.error('Error starting container:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/pods/:id/container/exec', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { command } = req.body;

    if (!command) {
      return res.status(400).json({ error: 'Command is required' });
    }

    // Ensure pod is fully loaded with container if it exists
    await ensurePodFullyLoaded(id);

    const result = await podManager.executeCommand(id, command);
    
    // Track command execution
    db.updateContainerActivity.run(Date.now(), id);
    
    res.json(result);
  } catch (error) {
    console.error('Error executing command:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post('/api/pods/:id/container/stop', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    await podManager.stopContainer(id);
    db.updateContainerStatus.run('stopped', id);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Helper function to build file tree
async function buildFileTree(dir: string, relativePath = ''): Promise<any> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const tree: any = { folders: [], files: [] };

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // Skip hidden files
    
    const entryPath = path.join(relativePath, entry.name);
    
    if (entry.isDirectory()) {
      const fullPath = path.join(dir, entry.name);
      const subTree = await buildFileTree(fullPath, entryPath);
      tree.folders.push({
        name: entry.name,
        path: entryPath,
        children: subTree,
      });
    } else {
      tree.files.push({
        name: entry.name,
        path: entryPath,
      });
    }
  }

  return tree;
}

// Admin endpoints for container management
app.get('/api/admin/containers', async (req, res) => {
  try {
    const labelFilters = req.query.labels as Record<string, string> | undefined;
    const containers = await podManager.findAllContainersForPods(labelFilters);
    
    const containerInfos = await Promise.all(
      containers.map(async (container) => {
        const info = await container.inspect();
        return {
          id: info.Id.substring(0, 12),
          name: info.Name,
          status: info.State.Status,
          labels: info.Config.Labels,
        };
      })
    );
    
    res.json({ containers: containerInfos });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/containers/cleanup', async (req, res) => {
  try {
    const orphaned = await podManager.cleanupOrphanedContainers();
    res.json({ 
      message: `Cleaned up ${orphaned.length} orphaned containers`,
      cleaned: orphaned,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/containers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { removeContainer } = await import('artipod');
    
    // Find the container by ID
    const containers = await podManager.findAllContainersForPods();
    const container = containers.find(c => c.id.startsWith(id));
    
    if (!container) {
      return res.status(404).json({ error: 'Container not found' });
    }
    
    await removeContainer(container);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`ArtiPod API server running on http://localhost:${PORT}`);
});
