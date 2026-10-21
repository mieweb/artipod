/** Compatibility binding for app callers; core owns upper migration and trust. */
import { openFileSystemWorkspaceUpper } from '../filesystem';
export { workspaceUpperPaths } from '@artipod/core/storage';
export function openWorkspaceUpper(options: { ref: string }) { return openFileSystemWorkspaceUpper(options.ref); }
