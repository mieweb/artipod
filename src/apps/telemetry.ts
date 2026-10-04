export interface RuntimeTelemetry {
  elapsedMs: number;
  retainedBytes: number;
  limitBytes: number;
}

export function parseRuntimeTelemetry(data: unknown): RuntimeTelemetry | null {
  if (!data || typeof data !== 'object') return null;
  const { elapsedMs, retainedBytes, limitBytes } = data as Record<string, unknown>;
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > Number.MAX_SAFE_INTEGER ||
      typeof retainedBytes !== 'number' || typeof limitBytes !== 'number' ||
      !Number.isSafeInteger(retainedBytes) || !Number.isSafeInteger(limitBytes) ||
      retainedBytes < 0 || limitBytes <= 0 || retainedBytes > limitBytes || limitBytes > 1024 * 1024 * 1024) return null;
  return { elapsedMs, retainedBytes, limitBytes };
}

export function observeRuntimeTelemetry(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  origin: string,
  source: () => Window | null,
  report: (value: RuntimeTelemetry) => void,
  now: () => number = () => performance.now(),
): () => void {
  let lastReport = -Infinity;
  const receive = (event: MessageEvent) => {
    const current = source();
    if (!current || event.source !== current || event.origin !== origin) return;
    const data = event.data;
    if (!data || data.type !== 'artipod:runtime-telemetry/v1') return;
    const telemetry = parseRuntimeTelemetry(data);
    if (!telemetry) return;
    const timestamp = now();
    if (timestamp - lastReport < 1000) return;
    lastReport = timestamp;
    report(telemetry);
  };
  target.addEventListener('message', receive);
  return () => target.removeEventListener('message', receive);
}