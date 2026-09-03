'use client';

/**
 * Editor chrome over @artipod/core/host's FileBuffer: open/save/dirty and
 * external-change detection live in the package; the surface is kerebron
 * (KerebronSurface, client-only — wasm). The surface is UNCONTROLLED:
 * `value` seeds it and edits flow up; external reloads remount it by key.
 */
import { useState, useEffect } from 'react';
import dynamicImport from 'next/dynamic';
import { FileBuffer } from '@artipod/core/host';
import type { PodEvents } from '@artipod/core/host';
import { fs } from '@/lib/filesystem';

const KerebronSurface = dynamicImport(() => import('@/components/KerebronSurface'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-gray-400">loading editor…</div>,
});

interface EditorProps {
  filepath: string;
  onClose: () => void;
  events?: PodEvents;
  readOnly?: boolean;
}

export default function Editor({ filepath, onClose, events, readOnly }: EditorProps) {
  const [buffer, setBuffer] = useState<FileBuffer | null>(null);
  const [seed, setSeed] = useState(''); // surface seed — changes only on open/reload
  const [generation, setGeneration] = useState(0); // remount key for external reloads
  const [isDirty, setIsDirty] = useState(false);
  const [externallyChanged, setExternallyChanged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let current: FileBuffer | null = null;
    setLoading(true);
    setError('');
    FileBuffer.open({ zfs: fs, path: filepath, events, readOnly })
      .then((b) => {
        if (disposed) {
          b.dispose();
          return;
        }
        current = b;
        setBuffer(b);
        setSeed(b.content);
        setIsDirty(b.isDirty);
        b.onChange((buf) => {
          setIsDirty(buf.isDirty);
          setExternallyChanged(buf.externallyChanged);
        });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      disposed = true;
      current?.dispose();
      setBuffer(null);
    };
  }, [filepath, events, readOnly]);

  const handleSave = async () => {
    if (!buffer) return;
    try {
      await buffer.save();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleReload = async () => {
    if (!buffer) return;
    await buffer.reload();
    setSeed(buffer.content);
    setExternallyChanged(false);
    setGeneration((g) => g + 1); // uncontrolled surface — remount with the fresh content
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#1e1e1e] text-white">
      <div className="flex items-center justify-between border-b border-gray-700 bg-[#2d2d2d] p-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold">{filepath}</h2>
          {isDirty && <span className="text-xs text-yellow-500">●</span>}
        </div>
        <div className="flex gap-2">
          <button onClick={handleSave} className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700">
            Save
          </button>
          <button onClick={onClose} className="rounded bg-gray-700 px-3 py-1 text-xs hover:bg-gray-600">
            Close
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900 p-2 text-xs text-white">{error}</div>}
      {externallyChanged && (
        <div className="flex items-center justify-between bg-yellow-900 p-2 text-xs text-yellow-100">
          <span>File changed on disk while you have unsaved edits.</span>
          <button onClick={() => void handleReload()} className="rounded bg-yellow-700 px-2 py-0.5 hover:bg-yellow-600">
            Reload (discard my edits)
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex flex-1 items-center justify-center">Loading...</div>
      ) : (
        <div className="relative flex-1 overflow-hidden">
          <KerebronSurface
            key={`${filepath}:${generation}`}
            language={buffer?.language ?? 'plaintext'}
            value={seed}
            onChange={(next) => buffer?.setContent(next)}
            readOnly={readOnly}
          />
        </div>
      )}
    </div>
  );
}
