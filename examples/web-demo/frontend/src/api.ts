const API_BASE = '/api';

export interface Pod {
  id: string;
  name: string;
  created_at: number;
  mounts?: Mount[];
  container?: Container;
}

export interface Mount {
  id: number;
  pod_id: string;
  mount_name: string;
  mount_path: string;
  readonly: boolean;
}

export interface Container {
  id?: number;
  pod_id?: string;
  container_id?: string;
  status: string;
  created_at?: number;
  last_command_at?: number;
  command_count?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  labels: Record<string, string>;
}

export interface FileTree {
  folders: { name: string; path: string }[];
  files: { name: string; path: string }[];
}

class ApiClient {
  async createFolder(path: string) {
    const res = await fetch(`${API_BASE}/fs/folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    return res.json();
  }

  async createFile(path: string, content: string = '') {
    const res = await fetch(`${API_BASE}/fs/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    return res.json();
  }

  async getFileTree(): Promise<FileTree> {
    const res = await fetch(`${API_BASE}/fs/tree`);
    return res.json();
  }

  async getWorkspaceFile(filePath: string): Promise<{ content: string; path: string; isIncluded?: boolean }> {
    const res = await fetch(`${API_BASE}/fs/file/${filePath}`);
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || 'Failed to read file');
    }
    return res.json();
  }

  async getPods(): Promise<Pod[]> {
    const res = await fetch(`${API_BASE}/pods`);
    return res.json();
  }

  async createPod(name: string, mounts: { name: string; path: string; readonly?: boolean }[] = []) {
    const res = await fetch(`${API_BASE}/pods`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mounts }),
    });
    return res.json();
  }

  async getPod(id: string): Promise<Pod> {
    const res = await fetch(`${API_BASE}/pods/${id}`);
    return res.json();
  }

  async getPodPrompt(id: string): Promise<{ prompt: string }> {
    const res = await fetch(`${API_BASE}/pods/${id}/prompt`);
    return res.json();
  }

  async deletePod(id: string) {
    const res = await fetch(`${API_BASE}/pods/${id}`, {
      method: 'DELETE',
    });
    return res.json();
  }

  async addMount(podId: string, name: string, path: string, readonly: boolean = false) {
    const res = await fetch(`${API_BASE}/pods/${podId}/mounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path, readonly }),
    });
    return res.json();
  }

  async getFiles(podId: string) {
    const res = await fetch(`${API_BASE}/pods/${podId}/files`);
    return res.json();
  }

  async createFileInMount(podId: string, mountName: string, filePath: string, content: string) {
    try {
      const res = await fetch(`${API_BASE}/pods/${podId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mountName, filePath, content }),
      });
      
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP error ${res.status}` }));
        throw new Error(data.error || 'Failed to create file');
      }
      
      return await res.json();
    } catch (error) {
      if (error instanceof Error && error.message.includes('fetch')) {
        throw new Error('Network error: Unable to reach server');
      }
      throw error;
    }
  }

  async createFolderInMount(podId: string, mountName: string, folderPath: string) {
    try {
      const res = await fetch(`${API_BASE}/pods/${podId}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mountName, folderPath }),
      });
      
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP error ${res.status}` }));
        throw new Error(data.error || 'Failed to create folder');
      }
      
      return await res.json();
    } catch (error) {
      if (error instanceof Error && error.message.includes('fetch')) {
        throw new Error('Network error: Unable to reach server');
      }
      throw error;
    }
  }

  async getFile(podId: string, mountName: string, filePath: string, startLine?: number, endLine?: number) {
    let url = `${API_BASE}/pods/${podId}/files/${mountName}/${filePath}`;
    const params = new URLSearchParams();
    if (startLine !== undefined) params.append('startLine', startLine.toString());
    if (endLine !== undefined) params.append('endLine', endLine.toString());
    if (params.toString()) url += `?${params.toString()}`;
    
    const res = await fetch(url);
    return res.json();
  }

  async updateFile(podId: string, mountName: string, filePath: string, content: string) {
    const res = await fetch(`${API_BASE}/pods/${podId}/files/${mountName}/${filePath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return res.json();
  }

  async startContainer(podId: string) {
    const res = await fetch(`${API_BASE}/pods/${podId}/container/start`, {
      method: 'POST',
    });
    return res.json();
  }

  async executeCommand(podId: string, command: string): Promise<CommandResult> {
    try {
      const res = await fetch(`${API_BASE}/pods/${podId}/container/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP error ${res.status}` }));
        throw new Error(data.error || 'Failed to execute command');
      }
      
      return await res.json();
    } catch (error) {
      if (error instanceof Error && error.message.includes('fetch')) {
        throw new Error('Network error: Unable to reach server');
      }
      throw error;
    }
  }

  async stopContainer(podId: string) {
    const res = await fetch(`${API_BASE}/pods/${podId}/container/stop`, {
      method: 'POST',
    });
    return res.json();
  }

  async getAllContainers(): Promise<ContainerInfo[]> {
    const res = await fetch(`${API_BASE}/admin/containers`);
    const data = await res.json();
    return data.containers;
  }

  async removeContainer(containerId: string) {
    const res = await fetch(`${API_BASE}/admin/containers/${containerId}`, {
      method: 'DELETE',
    });
    return res.json();
  }
}

export const api = new ApiClient();
