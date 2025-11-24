'use client';

import { useState, useEffect } from 'react';
import { fs } from '@/lib/filesystem';

interface EditorProps {
  filepath: string;
  onClose: () => void;
}

export default function Editor({ filepath, onClose }: EditorProps) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
      onClose();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white text-black w-3/4 h-3/4 flex flex-col rounded shadow-lg p-4">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">Editing: {filepath}</h2>
          <button onClick={onClose} className="text-red-500 hover:text-red-700">Close</button>
        </div>
        
        {error && <div className="bg-red-100 text-red-700 p-2 mb-2 rounded">{error}</div>}
        
        {loading ? (
          <div>Loading...</div>
        ) : (
          <textarea
            className="flex-1 w-full p-2 border border-gray-300 rounded font-mono"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        )}
        
        <div className="flex justify-end mt-4 gap-2">
          <button 
            onClick={onClose}
            className="px-4 py-2 bg-gray-200 rounded hover:bg-gray-300"
          >
            Cancel
          </button>
          <button 
            onClick={handleSave}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
