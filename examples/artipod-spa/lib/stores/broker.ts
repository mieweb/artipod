/**
 * Broker snapshot store (spa-ui-plan P4): serializable state ONLY — the
 * lease document and CryptoKeys live inside KeysService. Written by
 * KeysService, read by components via useStore.
 */
import { createStore } from 'zustand/vanilla';

export interface KeysMeta {
  authority: string;
  publicKey: string;
  podIds: string[];
  capTtlMs: number;
}

export interface BrokerSnapshot {
  /** none = not a broker serve; leased = live key; locked = broker present but no usable lease. */
  status: 'none' | 'leased' | 'locked';
  meta: KeysMeta | null;
  principal?: string;
  /** epoch ms */
  expiresAt?: number;
  /** A re-key (lease renewal) is in flight right now. */
  renewing?: boolean;
  /** epoch ms of the last successful key issue/renewal. */
  lastRenewedAt?: number;
}

export const brokerStore = createStore<BrokerSnapshot>()(() => ({
  status: 'none',
  meta: null,
}));
