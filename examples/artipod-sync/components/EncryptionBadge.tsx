'use client';

/**
 * The encryption indicator (serve plan S5.5): hidden on plaintext serves;
 * on a broker serve it shows leased (green, with expiry) or locked (amber,
 * click to re-login). Honest wording — the SERVER brokers the key.
 */
import { useSyncExternalStore } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { getBrokerState, onBrokerChange, brokerLogin, type BrokerState } from '@/lib/keys';

const timeShort = (ms?: number): string =>
  ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';

export default function EncryptionBadge({ principal }: { principal: () => Promise<string> }) {
  const state: BrokerState = useSyncExternalStore(onBrokerChange, getBrokerState, getBrokerState);
  if (state.status === 'none') return null;
  if (state.status === 'leased') {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-emerald-900/60 px-1.5 py-0.5 text-[11px] text-emerald-200"
        title={`encrypted at rest on the server (key broker: ${state.meta?.authority}) — this tab holds a key lease as ${state.principal} until ${timeShort(state.expiresAt)} (issued ${timeShort(state.lastRenewedAt)}, auto-renews before expiry); the key arrived ECDH-wrapped to this device (non-extractable, memory only) and also encrypts this tab's local store and working tree`}
      >
        <Lock size={11} /> encrypted · {state.renewing ? 're-keying…' : `leased until ${timeShort(state.expiresAt)}`}
      </span>
    );
  }
  return (
    <button
      onClick={() => void (async () => brokerLogin(await principal()))()}
      className="inline-flex items-center gap-1 rounded bg-amber-900/60 px-1.5 py-0.5 text-[11px] text-amber-200 hover:bg-amber-800/60"
      title={`the server brokers keys for this encrypted store but this tab holds no live lease${state.lastRenewedAt ? ` (last key issued ${timeShort(state.lastRenewedAt)} — renewal failed, server offline or token required)` : ''} — click to login`}
    >
      <LockOpen size={11} /> {state.renewing ? 're-keying…' : 'encrypted · locked — login'}
    </button>
  );
}
