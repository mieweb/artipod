'use client';

/**
 * Thin Monaco shell over @artipod/core/host's FileBuffer (plan Phase 2):
 * Monaco, save/close chrome and the dirty dot live here; open/save/dirty
 * tracking and external-change detection (fs:changed) live in the package.
 */
import { useState, useEffect } from 'react';
import MonacoEditor from '@monaco-editor/react';
import { FileBuffer } from '@artipod/core/host';
import type { PodEvents } from '@artipod/core/host';
import { fs } from '@/lib/filesystem';

interface EditorProps {
  filepath: string;
  onClose: () => void;
  events?: PodEvents;
  readOnly?: boolean;
}

export default function Editor({ filepath, onClose, events, readOnly }: EditorProps) {
  const [buffer, setBuffer] = useState<FileBuffer | null>(null);
  const [content, setContent] = useState('');
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
        setContent(b.content);
        setIsDirty(b.isDirty);
        b.onChange((buf) => {
          setContent(buf.content);
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

  return (
    <div className="w-full h-full flex flex-col bg-[#1e1e1e] text-white overflow-hidden">
      <div className="flex justify-between items-center p-2 bg-[#2d2d2d] border-b border-gray-700">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold">{filepath}</h2>
          {isDirty && <span className="text-xs text-yellow-500">●</span>}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Save
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs bg-gray-700 rounded hover:bg-gray-600"
          >
            Close
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900 text-white p-2 text-xs">{error}</div>}
      {externallyChanged && (
        <div className="flex items-center justify-between bg-yellow-900 text-yellow-100 p-2 text-xs">
          <span>File changed on disk while you have unsaved edits.</span>
          <button
            onClick={() => void buffer?.reload()}
            className="px-2 py-0.5 bg-yellow-700 rounded hover:bg-yellow-600"
          >
            Reload (discard my edits)
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex-1 flex items-center justify-center">Loading...</div>
      ) : (
        <div className="flex-1 relative">
          <MonacoEditor
            height="100%"
            theme="vs-dark"
            path={filepath}
            defaultLanguage={buffer?.language ?? 'plaintext'}
            value={content}
            onChange={(value) => buffer?.setContent(value || '')}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              scrollBeyondLastLine: false,
              readOnly: readOnly ?? false,
            }}
          />
        </div>
      )}
    </div>
  );
}
