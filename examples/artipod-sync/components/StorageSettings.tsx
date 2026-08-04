'use client';

import { useEffect, useState } from 'react';
import type { MigrationProgress, StorageBackend, StorageUsage } from '@/lib/sandbox/storage';

interface StorageSettingsProps {
  backend: StorageBackend;
  isPrimaryTab: boolean;
}

function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GiB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MiB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KiB`;
  return `${n} B`;
}

export default function StorageSettings({ backend, isPrimaryTab }: StorageSettingsProps) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [opfsOk, setOpfsOk] = useState(false);
  const [progress, setProgress] = useState<MigrationProgress | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    (async () => {
      const storage = await import('@/lib/sandbox/storage');
      setUsage(await storage.getStorageUsage());
      setOpfsOk(await storage.supportsOpfs());
    })();
  }, []);

  const handlePersist = async () => {
    const storage = await import('@/lib/sandbox/storage');
    const granted = await storage.requestPersistence();
    setStatus(granted ? 'Persistent storage granted.' : 'Persistence request was denied.');
    setUsage(await storage.getStorageUsage());
  };

  const handleMigrate = async (to: StorageBackend) => {
    if (!isPrimaryTab) return;
    const storage = await import('@/lib/sandbox/storage');
    setStatus(`Migrating to ${to}…`);
    try {
      const { files, bytes } = await storage.migrateStorage(to, setProgress);
      setStatus(`Migrated ${files} files (${formatBytes(bytes)}). Reloading…`);
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setProgress(null);
      setStatus(`Migration failed: ${(e as Error).message}`);
    }
  };

  const otherBackend: StorageBackend = backend === 'opfs' ? 'indexeddb' : 'opfs';
  const canMigrate = isPrimaryTab && (otherBackend !== 'opfs' || opfsOk);

  return (
    <section
      aria-label="Storage settings"
      className="h-full w-full bg-[#1e1e1e] text-white p-6 overflow-auto"
    >
      <h2 className="text-lg font-bold mb-4">Storage</h2>

      {!isPrimaryTab && (
        <div role="alert" className="mb-4 rounded bg-yellow-900 p-3 text-sm">
          This filesystem is already open in another tab — migration is disabled here. Close the other tab and reload to switch backends.
        </div>
      )}

      <dl className="text-sm space-y-2 mb-6">
        <div className="flex gap-2">
          <dt className="text-gray-400 w-40">Backend</dt>
          <dd className="font-mono">{backend}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-gray-400 w-40">OPFS available</dt>
          <dd>{opfsOk ? 'yes' : 'no'}</dd>
        </div>
        {usage && (
          <>
            <div className="flex gap-2">
              <dt className="text-gray-400 w-40">Usage</dt>
              <dd>
                {formatBytes(usage.usage)} of {formatBytes(usage.quota)}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-gray-400 w-40">Persisted</dt>
              <dd>{usage.persisted ? 'yes' : 'no'}</dd>
            </div>
          </>
        )}
      </dl>

      <div className="flex flex-wrap gap-3 mb-4">
        <button
          onClick={handlePersist}
          className="px-3 py-1.5 text-sm bg-gray-700 rounded hover:bg-gray-600"
          aria-label="Request persistent storage"
        >
          Request persistence
        </button>
        <button
          onClick={() => handleMigrate(otherBackend)}
          disabled={!canMigrate}
          className="px-3 py-1.5 text-sm bg-blue-700 rounded hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label={`Migrate storage to ${otherBackend}`}
        >
          Migrate to {otherBackend}
        </button>
      </div>

      {progress && (
        <div className="text-sm text-gray-300 mb-2" aria-live="polite">
          {progress.copied}/{progress.total} — <span className="font-mono">{progress.currentPath}</span>
        </div>
      )}
      {status && (
        <p className="text-sm text-gray-300" aria-live="polite">
          {status}
        </p>
      )}
    </section>
  );
}
