'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { useStore } from 'zustand';
import { Play, Square, RotateCw, Maximize2, Minimize2, X } from 'lucide-react';
import type { PodSession } from '@/lib/services/pod-session';
import {
  controlRuntimeLifecycle, observeRuntimeTelemetry,
  type LifecycleController, type LifecycleSnapshot, type RuntimeTelemetry,
} from '@artipod/core/apps';
import styles from './ApplicationPreview.module.css';

function PreviewInstance({ url, control, onLifecycle }: {
  url: string; control: MutableRefObject<LifecycleController | null>; onLifecycle(value: LifecycleSnapshot): void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [telemetry, setTelemetry] = useState<RuntimeTelemetry | null>(null);
  const [suspended, setSuspended] = useState(false);
  useEffect(() => {
    const source = () => frame.current?.contentWindow ?? null;
    const stopTelemetry = observeRuntimeTelemetry(window, location.origin, source, setTelemetry);
    const controller = controlRuntimeLifecycle(window, location.origin, source, value => {
      setSuspended(value.state === 'suspended');
      if (value.telemetry) setTelemetry(value.telemetry);
      onLifecycle(value);
    });
    control.current = controller;
    return () => { stopTelemetry(); controller.dispose(); control.current = null; onLifecycle({ state: 'unknown' }); };
  }, [control, onLifecycle]);
  return <>
    {telemetry && <div className={styles.telemetry} aria-label="App-reported runtime metrics">
      <span>Elapsed: {Math.floor(telemetry.elapsedMs / 1000)} s</span>
      <span title="Retained buffer bytes reported by the application, not total JavaScript heap or DOM memory.">
        App-retained memory (reported): {(telemetry.retainedBytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KiB
      </span>
      <span>Limit: {(telemetry.limitBytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB</span>
      {suspended && <span>Suspended</span>}
    </div>}
    <iframe ref={frame} title="Running pod application" src={url} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" />
  </>;
}

export default function ApplicationPreview({ session, focused, onFocus }: {
  session: PodSession; focused: boolean; onFocus(value: boolean): void;
}) {
  const snapshot = useStore(session.runtime.store);
  const [confirm, setConfirm] = useState(false);
  const [lifecycle, setLifecycle] = useState<LifecycleSnapshot>({ state: 'unknown' });
  const control = useRef<LifecycleController | null>(null);
  const busy = snapshot.phase === 'opening';
  const launch = (mode: 'release' | 'development', authorize = false) => {
    setConfirm(false);
    void session.runtime.launch(mode, authorize);
  };
  const close = () => { setConfirm(false); session.runtime.stop(); };
  const suspended = lifecycle.state === 'suspended';
  const canToggle = snapshot.phase === 'running' && (lifecycle.state === 'running' || suspended);
  const toggleTitle = lifecycle.state === 'unsupported' ? 'This application does not support suspension'
    : lifecycle.state === 'unknown' ? 'Waiting for the application' : suspended ? 'Resume the application' : 'Stop the application in place';
  return <section className={styles.preview} aria-label="Application preview">
    <div className={styles.toolbar}>
      <button disabled={busy} onClick={() => launch('release')} title="Verify signed release and run"><Play size={16} />Run approved</button>
      <button disabled={busy} onClick={() => setConfirm(true)} title="Authorize this local workspace for development"><Play size={16} />Run in development</button>
      <button disabled={snapshot.phase !== 'running'} onClick={() => launch(snapshot.mode!)} title="Reload saved application files" aria-label="Reload saved application"><RotateCw size={16} /></button>
      <button disabled={!canToggle} onClick={() => (suspended ? control.current?.resume() : control.current?.suspend())} title={toggleTitle} aria-label={suspended ? 'Resume application' : 'Stop application'}>{suspended ? <Play size={16} /> : <Square size={16} />}</button>
      <button disabled={snapshot.phase === 'stopped'} onClick={close} title="Close and revoke execution" aria-label="Close application"><X size={16} /></button>
      <button onClick={() => onFocus(!focused)} title={focused ? 'Return to workspace' : 'Open app-focused view'} aria-label={focused ? 'Return to workspace' : 'Open app-focused view'}>{focused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
    </div>
    <div className={styles.status} role="status">
      {snapshot.phase === 'opening' ? 'Preparing application...' : snapshot.phase === 'running' ? snapshot.mode === 'development' ? 'Development (unapproved)' : 'Approved release' : snapshot.phase === 'error' ? snapshot.error : 'Closed'}
      {snapshot.digest && <span title={snapshot.digest}>{snapshot.digest.slice(0,23)}</span>}
      {snapshot.validUntil && <span>Until {new Date(snapshot.validUntil).toLocaleTimeString()}</span>}
      {snapshot.phase === 'running' && suspended && <span>Suspended by you</span>}
      {snapshot.phase === 'running' && lifecycle.state === 'error' && <span>{lifecycle.error}</span>}
    </div>
    {confirm && <div role="dialog" aria-modal="false" aria-labelledby="development-title" className={styles.confirm}>
      <h2 id="development-title">Authorize local development?</h2>
      <p>{session.route.id}</p>
      <p>This unapproved application will share this origin&apos;s browser authority, including access to your other pods. Authorization lasts only for this workspace session.</p>
      <div><button onClick={() => launch('development', true)}><Play size={16} />Authorize and run</button><button onClick={() => setConfirm(false)}>Cancel</button></div>
    </div>}
    {snapshot.url && <PreviewInstance key={snapshot.url} url={snapshot.url} control={control} onLifecycle={setLifecycle} />}
  </section>;
}