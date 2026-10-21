/** Environment adapters are shared by all protected-storage consumers. */
export {
  memoryKeyValue,
  memoryMirror,
  nodeAdapters,
  idbKeyValue,
  localStorageMirror,
  browserAdapters,
} from '@artipod/core/storage';
export type { KeyValue, Mirror, ServiceAdapters } from '@artipod/core/storage';
