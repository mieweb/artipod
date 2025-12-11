import { ArtiPod, ArtiMount, ContainerHandle, findAllContainers, removeContainer } from 'artipod';
import * as path from 'path';
import * as fs from 'fs/promises';

const WORKSPACE_ROOT = path.join(__dirname, '../../workspace/files');

interface PodInstance {
  pod: ArtiPod;
  mounts: Map<string, ArtiMount>;
}

class PodManager {
  private pods: Map<string, PodInstance> = new Map();

  async createPod(podId: string): Promise<ArtiPod> {
    const pod = new ArtiPod([]);
    this.pods.set(podId, {
      pod,
      mounts: new Map(),
    });
    return pod;
  }

  async ensurePodLoaded(podId: string, mounts: Array<{ mount_name: string; mount_path: string }>, containerData?: { container_id: string; status: string }): Promise<void> {
    // If pod is already in memory, nothing to do
    const existingInstance = this.pods.get(podId);
    if (existingInstance) {
      return;
    }

    // Create pod instance
    const pod = new ArtiPod([]);
    const podInstance: PodInstance = {
      pod,
      mounts: new Map(),
    };
    this.pods.set(podId, podInstance);

    // Restore all mounts
    for (const mount of mounts) {
      const fullPath = path.join(WORKSPACE_ROOT, mount.mount_path);
      const artiMount = new ArtiMount(mount.mount_name, fullPath);
      
      pod.addMount(artiMount);
      podInstance.mounts.set(mount.mount_name, artiMount);
    }

    // Note: Container reconnection on restart is not implemented yet
    // Would need to store container handle and restore it
  }

  async addMount(podId: string, mountName: string, mountPath: string): Promise<void> {
    const instance = this.pods.get(podId);
    if (!instance) {
      throw new Error(`Pod ${podId} not found`);
    }

    const fullPath = path.join(WORKSPACE_ROOT, mountPath);
    const mount = new ArtiMount(mountName, fullPath);
    
    instance.pod.addMount(mount);
    instance.mounts.set(mountName, mount);
  }

  getPod(podId: string): ArtiPod | undefined {
    return this.pods.get(podId)?.pod;
  }

  getMount(podId: string, mountName: string): ArtiMount | undefined {
    return this.pods.get(podId)?.mounts.get(mountName);
  }

  async startContainer(podId: string, dockerfilePath: string, seccompProfilePath?: string): Promise<ContainerHandle> {
    const instance = this.pods.get(podId);
    if (!instance) {
      throw new Error(`Pod ${podId} not found`);
    }

    return await instance.pod.startContainer(dockerfilePath, {
      seccompProfilePath,
      labels: { pod_id: podId },
    });
  }

  async stopContainer(podId: string): Promise<void> {
    const instance = this.pods.get(podId);
    if (!instance) {
      throw new Error(`Pod ${podId} not found`);
    }

    await instance.pod.stopContainer();
  }

  async executeCommand(podId: string, command: string) {
    const instance = this.pods.get(podId);
    if (!instance) {
      throw new Error(`Pod ${podId} not found`);
    }

    return await instance.pod.executeCommand(command);
  }

  hasContainer(podId: string): boolean {
    const instance = this.pods.get(podId);
    return instance ? instance.pod.hasContainer() : false;
  }

  getContainerId(podId: string): string | undefined {
    return this.pods.get(podId)?.pod.getContainerId();
  }

  /**
   * Find all artipod-managed containers, optionally filtered by labels
   */
  async findAllContainersForPods(labelFilters?: Record<string, string>) {
    return await findAllContainers(labelFilters);
  }

  /**
   * Clean up orphaned containers that don't correspond to any loaded pods
   */
  async cleanupOrphanedContainers() {
    // Find all artipod-managed containers
    const allContainers = await findAllContainers();
    const loadedPodIds = new Set(this.pods.keys());
    const orphaned: any[] = [];

    for (const container of allContainers) {
      const info = await container.inspect();
      const podId = info?.Config.Labels?.['artipod.pod_id'];
      
      if (podId && !loadedPodIds.has(podId)) {
        orphaned.push({ container, podId, info });
      }
    }

    console.log(`Found ${orphaned.length} orphaned containers`);

    // Remove each orphaned container
    for (const { container, podId } of orphaned) {
      try {
        await removeContainer(container);
        console.log(`Cleaned up orphaned container for pod ${podId}`);
      } catch (err) {
        console.warn(`Failed to cleanup orphaned container for pod ${podId}:`, err);
      }
    }

    return orphaned.map(o => ({ podId: o.podId, containerId: o.info.Id }));
  }
}

export const podManager = new PodManager();
