import type { PodEvents } from '@artipod/core/host';
import { hostSave } from './host-save';

/** Own the edit debounce in the host so save also sees scheduled/inflight pushes. */
export function workspaceAutoPush(options: {
  events: Pick<PodEvents, 'on'>;
  push(): Promise<unknown>;
  enabled(): boolean;
  onError(error: unknown): void;
}): () => void {
  let disposed = false;
  const push = async () => { if (!disposed && options.enabled()) await options.push(); };
  const off = options.events.on('fs:changed', () => {
    if (!disposed && options.enabled()) hostSave.schedule(push, 2000, options.onError);
  });
  return () => { disposed = true; off(); hostSave.forget(push); };
}
