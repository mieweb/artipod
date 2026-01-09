/**
 * Basic ArtiPod Usage Example
 * 
 * This example demonstrates the new automatic "main" mount feature.
 */

import { ArtiPod, ArtiMount } from '../../src';
import * as path from 'path';
import * as fs from 'fs/promises';

async function main() {
  const workspaceDir = path.join(process.cwd(), 'example-workspaces');
  
  // Ensure workspace directory exists
  await fs.mkdir(workspaceDir, { recursive: true });

  console.log('=== Example 1: Automatic Main Mount ===\n');
  
  // Create a pod with automatic main mount
  const pod1 = new ArtiPod({ workspaceDir });
  await pod1.initialize();
  
  console.log(`Pod ID: ${pod1.getId()}`);
  console.log(`Main mount created: ${pod1.getMount('main')?.getName()}`);
  console.log(`Main mount path: ${pod1.getMount('main')?.getRootPath()}`);
  console.log(`Main mount is writable: ${!pod1.getMount('main')?.isReadOnly()}\n`);

  // Write a test file to the main mount
  const mainMount = pod1.getMount('main')!;
  await mainMount.write('test.txt', 'Hello from ArtiPod!');
  console.log('✓ Wrote test.txt to main mount');
  
  const content = await mainMount.read('test.txt');
  console.log(`✓ Read back: "${content}"\n`);

  console.log('=== Example 2: Custom Pod ID (Persistence) ===\n');
  
  // Create pod with custom ID
  const customId = 'my-persistent-pod';
  const pod2 = new ArtiPod({ 
    id: customId, 
    workspaceDir 
  });
  await pod2.initialize();
  
  console.log(`Pod ID: ${pod2.getId()}`);
  console.log(`Main mount path: ${pod2.getMount('main')?.getRootPath()}`);
  
  // Write a file
  await pod2.getMount('main')!.write('persistent.txt', 'This will persist!');
  console.log('✓ Wrote persistent.txt\n');

  // "Restart" - create new pod instance with same ID
  const pod2Reloaded = new ArtiPod({ 
    id: customId, 
    workspaceDir 
  });
  await pod2Reloaded.initialize();
  
  console.log('Reloaded pod with same ID...');
  const persistedContent = await pod2Reloaded.getMount('main')!.read('persistent.txt');
  console.log(`✓ Successfully read persisted file: "${persistedContent}"\n`);

  console.log('=== Example 3: No Main Mount ===\n');
  
  // Create pod without automatic main mount
  const pod3 = new ArtiPod({ useMainMount: false });
  await pod3.initialize();
  
  console.log(`Pod ID: ${pod3.getId()}`);
  console.log(`Main mount exists: ${pod3.getMount('main') !== undefined}`);
  console.log(`Mount count: ${pod3.getMounts().length}\n`);

  console.log('=== Example 4: Additional Mounts ===\n');
  
  const pod4 = new ArtiPod({ workspaceDir });
  
  // Create additional mount directories
  const docsMountPath = path.join(workspaceDir, 'docs-example');
  await fs.mkdir(docsMountPath, { recursive: true });
  await fs.writeFile(path.join(docsMountPath, 'README.md'), '# Documentation');
  
  const docsMount = new ArtiMount('docs', docsMountPath, true); // read-only
  
  await pod4.initialize();
  await docsMount.initialize();
  pod4.addMount(docsMount);
  
  console.log(`Pod ID: ${pod4.getId()}`);
  console.log(`Mount count: ${pod4.getMounts().length}`);
  console.log(`Mounts: ${pod4.getMountNames().join(', ')}\n`);

  console.log('=== Cleanup ===\n');
  
  // Clean up main mounts
  await pod1.cleanupMainMount();
  console.log('✓ Cleaned up pod1 main mount');
  
  await pod2.cleanupMainMount();
  console.log('✓ Cleaned up pod2 main mount');
  
  await pod4.cleanupMainMount();
  console.log('✓ Cleaned up pod4 main mount');
  
  // Clean up example directories
  await fs.rm(workspaceDir, { recursive: true, force: true });
  console.log('✓ Cleaned up workspace directory\n');
  
  console.log('Done!');
}

main().catch(console.error);
