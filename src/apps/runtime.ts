import { captureApplication } from './capture.js';
import { MAX_APPROVAL_MS, verifyRelease, type AdmissionPolicy, type ReleaseEvidence } from './admission.js';
import { applicationSource, type ApplicationFiles } from './files.js';
import { parseExecutableDescriptor } from './descriptor.js';
import type { LifecycleSnapshot, LifecycleState } from './lifecycle.js';
import type { ProcessHandle, ProcessTable } from '../proc/processes.js';

/** Minimal external store; shape-compatible with zustand's `useStore`. */
export interface SnapshotStore<T> {
  getState(): T;
  getInitialState(): T;
  setState(next: T): void;
  subscribe(listener: (state: T, previous: T) => void): () => void;
}

export function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let state = initial;
  const listeners = new Set<(state: T, previous: T) => void>();
  return {
    getState: () => state,
    getInitialState: () => initial,
    setState(next) {
      const previous = state;
      state = next;
      for (const listener of listeners) listener(state, previous);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export interface RuntimeSnapshot {
  phase: 'stopped' | 'opening' | 'running' | 'error';
  mode?: 'release' | 'development';
  url?: string;
  digest?: string;
  error?: string;
  publisher?: string;
  approver?: string;
  validUntil?: number;
  /** Cooperative lifecycle of the running instance, as last reported by the UI's controller. */
  lifecycle?: LifecycleSnapshot;
  /** pid in the session's process table, when one was supplied. */
  pid?: number;
}

/** What the rendering side gives the runtime so shell signals can reach the iframe. */
export interface RuntimeInstance {
  suspend(): void;
  resume(): void;
}

export interface BrowserRuntimeOptions {
  /** Register each launched instance as an `app` process (ps / kill). */
  processes?: ProcessTable;
  /** Extra columns for the process row, e.g. the pod ref. */
  detail?: Record<string, string>;
}

export async function boundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) throw new Error(`Host request failed (${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    let next = await reader.read();
    while (!next.done) {
      size += next.value.byteLength;
      if (size > limit) throw new Error('Response too large');
      chunks.push(next.value);
      next = await reader.read();
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function deadline<Value>(promise: Promise<Value>, label: string): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 8000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

const mime = (path: string) => ({
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css', json: 'application/json', map: 'application/json', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', wasm: 'application/wasm', woff2: 'font/woff2',
}[path.split('.').pop() ?? ''] ?? 'application/octet-stream');

export function createBrowserRuntime(files: ApplicationFiles, root: string, options: BrowserRuntimeOptions = {}) {
  const store = createSnapshotStore<RuntimeSnapshot>({ phase: 'stopped' });
  let generation = 0;
  let session = '';
  let worker: ServiceWorker | null = null;
  let port: MessagePort | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let development: string | undefined;
  let disposed = false;
  let process: ProcessHandle | undefined;
  let instance: RuntimeInstance | null = null;
  const unsupported = (action: string) => () => { throw new Error(`Application does not support ${action}`); };
  const stop = () => {
    generation++;
    if (session) worker?.postMessage({ type: 'revoke', session });
    session = '';
    port?.close();
    port = undefined;
    clearTimeout(timer);
    process?.exit();
    process = undefined;
    store.setState({ phase: 'stopped' });
  };
  const revoke = () => { development = undefined; stop(); };
  const requirements = (descriptor: ReturnType<typeof parseExecutableDescriptor>, paths: readonly string[]) => JSON.stringify({
    root, entrypoint: descriptor.entrypoint, capabilities: descriptor.capabilities, dependencies: descriptor.dependencies,
    mounts: descriptor.mounts, paths: [...paths].sort(),
  });
  return {
    store,
    stop: revoke,
    dispose() { disposed = true; revoke(); },
    /**
     * The rendering side attaches the live iframe's lifecycle controller so
     * `kill -STOP/-CONT` reach the app. Returns the detach function.
     */
    attach(next: RuntimeInstance): () => void {
      instance = next;
      return () => { if (instance === next) instance = null; };
    },
    /** Mirror the controller's lifecycle into the snapshot and the process row. */
    report(lifecycle: LifecycleSnapshot): void {
      const current = store.getState();
      if (current.phase !== 'running') return;
      store.setState({ ...current, lifecycle });
      const state: Record<LifecycleState, string> = {
        unknown: 'running', unsupported: 'running', running: 'running', suspending: 'suspending',
        suspended: 'suspended', resuming: 'resuming', error: 'running',
      };
      const detail: Record<string, string> = {};
      if (lifecycle.telemetry) {
        detail.elapsed = `${Math.floor(lifecycle.telemetry.elapsedMs / 1000)}s`;
        detail.retained = `${Math.round(lifecycle.telemetry.retainedBytes / 1024)}KiB`;
      }
      process?.update({ state: state[lifecycle.state], detail });
    },
    async launch(mode: 'release' | 'development', authorize = false) {
      if (disposed) throw new Error('Workspace closed');
      stop();
      const current = generation;
      store.setState({ phase: 'opening', mode });
      try {
        const source = await deadline(applicationSource(files, root), 'Application scan');
        const captured = await deadline(captureApplication(source), 'Application snapshot');
        const descriptor = parseExecutableDescriptor(captured.read('/app/artipod.json'));
        if (descriptor.mounts.length) throw new Error('This application requires a resolved CasePod mount; no case is selected');
        const fingerprint = requirements(descriptor, source.paths);
        let validUntil = Date.now() + MAX_APPROVAL_MS;
        let publisher: string | undefined;
        let approver: string | undefined;
        if (mode === 'development') {
          if (!authorize && development !== fingerprint) throw new Error('Development authorization required for these application requirements');
        } else {
          const load = async (path: string, missing: string) => {
            let response: Response;
            try {
              response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
            } catch {
              throw new Error('Cannot reach the approval server. Check your connection and try again.');
            }
            if (response.status === 404) throw new Error(missing);
            if (response.status === 401 || response.status === 403) throw new Error('You do not have access to the approval information. Contact the server administrator.');
            if (!response.ok) throw new Error('The server could not provide approval information. Try again later.');
            return JSON.parse(new TextDecoder().decode(await boundedResponse(response, 256 * 1024)));
          };
          const policy = await load('/execution-policy.json', 'Approved execution is not configured on this server.') as Omit<AdmissionPolicy, 'clock' | 'revokedApprovalIds'>;
          const evidence = await load(`/execution-approvals/${captured.subject.digest.slice(7)}.json`, 'No signed approval is available for this version of the application.') as ReleaseEvidence;
          const verified = await verifyRelease(captured.subject, evidence, { ...policy, clock: () => Date.now(), revokedApprovalIds: new Set() });
          ({ validUntil, publisher, approver } = verified);
        }
        if (current !== generation || disposed) throw new Error('Launch cancelled');
        const registration = await deadline(navigator.serviceWorker.register('/artipod-runtime-sw.js', { scope: '/' }), 'Runtime worker registration');
        if (!registration.active) await deadline(navigator.serviceWorker.ready, 'Runtime worker activation');
        if (!navigator.serviceWorker.controller) {
          await deadline(new Promise<void>(resolve => {
            navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
          }), 'Runtime worker control');
        }
        if (current !== generation || disposed) throw new Error('Launch cancelled');
        worker = registration.active;
        if (!worker) throw new Error('Runtime worker unavailable');
        session = crypto.randomUUID();
        const admitted = session;
        const channel = new MessageChannel();
        port = channel.port1;
        await deadline(new Promise<void>(resolve => {
          channel.port1.onmessage = event => {
            if (current !== generation || session !== admitted) return;
            if (event.data?.type === 'ready') { resolve(); return; }
            const { type, id, path } = event.data ?? {};
            if (type !== 'read' || typeof id !== 'string' || id.length > 64 || typeof path !== 'string' || path.length > 512) return;
            try {
              if (Date.now() >= validUntil) { revoke(); return; }
              channel.port1.postMessage({ id, status: 200, mime: mime(path), bytes: captured.read(path) });
            } catch { channel.port1.postMessage({ id, status: 404 }); }
          };
          worker!.postMessage({ type: 'grant', session: admitted, entrypoint: `/app/${captured.entrypoint}`, validUntil }, [channel.port2]);
        }), 'Runtime worker grant');
        if (current !== generation || disposed) throw new Error('Launch cancelled');
        if (mode === 'development') development = fingerprint;
        timer = setTimeout(revoke, Math.max(0, validUntil - Date.now()));
        const url = `/_artipod/run/${admitted}/app/${captured.entrypoint}`;
        process = options.processes?.spawn({
          kind: 'app', name: descriptor.name,
          detail: { ...options.detail, mode, digest: captured.subject.digest.slice(0, 19), url },
          signal: {
            STOP: () => (instance ?? { suspend: unsupported('suspend') }).suspend(),
            CONT: () => (instance ?? { resume: unsupported('resume') }).resume(),
            TERM: revoke,
            KILL: revoke,
          },
        });
        store.setState({ phase: 'running', mode, digest: captured.subject.digest, publisher, approver, validUntil, url, pid: process?.pid });
      } catch (error) {
        if (current === generation) {
          stop();
          store.setState({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
  };
}

export type BrowserRuntime = ReturnType<typeof createBrowserRuntime>;