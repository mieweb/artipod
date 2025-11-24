'use client';

import { useState, useEffect } from 'react';
import { fs } from '@/lib/filesystem';
import MonacoEditor from '@monaco-editor/react';

interface EditorProps {
  filepath: string;
  onClose: () => void;
}

export default function Editor({ filepath, onClose }: EditorProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isDirty, setIsDirty] = useState(false);

  useEffect(() => {
    const loadFile = async () => {
      try {
        // Check if file exists
        if (fs.existsSync(filepath)) {
          const data = await fs.promises.readFile(filepath, 'utf8');
          setContent(data as string);
        } else {
          // New file
          setContent('');
        }
      } catch (e: any) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    loadFile();
  }, [filepath]);

  const handleSave = async () => {
    try {
      await fs.promises.writeFile(filepath, content);
      setIsDirty(false);
      // Optional: Show success message
    } catch (e: any) {
      setError(e.message);
    }
  };

  const getLanguage = (path: string) => {
    if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
    if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript';
    if (path.endsWith('.json')) return 'json';
    if (path.endsWith('.css')) return 'css';
    if (path.endsWith('.html')) return 'html';
    if (path.endsWith('.md')) return 'markdown';
    return 'plaintext';
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
            className="px-3 py-1 text-xs bg-gray-600 rounded hover:bg-gray-500"
          >
            Close
          </button>
        </div>
      </div>
      
      {error && <div className="bg-red-900 text-white p-2 text-xs">{error}</div>}
      
      {loading ? (
        <div className="flex-1 flex items-center justify-center">Loading...</div>
      ) : (
        <div className="flex-1 relative">
          <MonacoEditor
            height="100%"
            theme="vs-dark"
            path={filepath}
            defaultLanguage={getLanguage(filepath)}
            value={content}
            onChange={(value) => {
              setContent(value || '');
              setIsDirty(true);
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      )}
    </div>
  );
}
