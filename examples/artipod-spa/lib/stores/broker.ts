/**
 * Serializable broker status only. The signed lease and CryptoKeys stay
 * inside the core KeysService; this store is the SPA render surface.
 */
import { createStore } from 'zustand/vanilla';
import type { BrokerSnapshot } from '@artipod/core/storage';
export type { BrokerSnapshot, KeysMeta } from '@artipod/core/storage';

export const brokerStore = createStore<BrokerSnapshot>()(() => ({
  status: 'none',
  meta: null,
}));
