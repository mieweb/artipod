'use client';

/**
 * The encryption indicator (serve plan S5.5), on brokerStore: hidden on
 * plaintext serves; leased (green, expiry + release) or locked (amber,
 * click to re-login). Honest wording — the SERVER brokers the key.
 * Tooltips carried over verbatim from the old app (plan U2: they encode
 * the honest semantics).
 */
import { useStore } from 'zustand';
import { useState } from 'react';
import { Lock, LockOpen, X } from 'lucide-react';
import { brokerStore } from '@/lib/stores/broker';
import { keys } from '@/lib/boot';

const timeShort = (ms?: number): string =>
  ms ? new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';

export default function EncryptionBadge({ principal }: { principal: () => Promise<string> }) {
  const state = useStore(brokerStore);
  const [loginError, setLoginError] = useState<string | null>(null);
  const login = async (): Promise<void> => {
    setLoginError(null);
    try {
      if (!(await keys().login(await principal()))) {
        setLoginError(keys().probeError ?? 'Login failed. Reconnect or restore access to the key broker, then try again.');
      }
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Login failed. Please try again.');
    }
  };
  if (state.status === 'none') return null;
  if (state.status === 'leased' && state.expiresAt && state.expiresAt > Date.now()) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-emerald-900/60 px-1.5 py-0.5 text-[11px] text-emerald-200"
        title={`encrypted at rest on the server (key broker: ${state.meta?.authority}) — this tab holds a key lease as ${state.principal} until ${timeShort(state.expiresAt)} (issued ${timeShort(state.lastRenewedAt)}, auto-renews before expiry); the key arrived ECDH-wrapped to this device (non-extractable, memory only) and also encrypts this tab's local store and working tree`}
      >
        <Lock size={11} /> encrypted · {state.renewing ? 're-keying…' : `leased until ${timeShort(state.expiresAt)}`}
        <button
          onClick={(e) => {
            e.preventDefault();
            keys().release();
          }}
          className="-mr-0.5 rounded p-0.5 text-emerald-300 hover:bg-emerald-800/80 hover:text-white"
          title="release the lease NOW — the key evaporates from this tab's memory (≈ artipod lock); encrypted reads fail until you log in again, ciphertext at rest is untouched"
          aria-label="Release the key lease"
        >
          <X size={11} />
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        onClick={() => void login()}
        disabled={state.renewing}
        className="inline-flex items-center gap-1 rounded bg-amber-900/60 px-1.5 py-0.5 text-[11px] text-amber-200 hover:bg-amber-800/60"
        title={`the server brokers keys for this encrypted store but this tab holds no live lease${state.lastRenewedAt ? ` (last key issued ${timeShort(state.lastRenewedAt)} — renewal failed, server offline or token required)` : ''} — click to login`}
      >
        <LockOpen size={11} /> {state.renewing ? 're-keying…' : 'encrypted · locked — login'}
      </button>
      {loginError && <span role="alert" className="text-xs">{loginError}</span>}
    </span>
  );
}
