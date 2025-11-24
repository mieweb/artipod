'use client';

import { useEffect, useState, useRef } from 'react';
import dynamicImport from 'next/dynamic';
import { initFileSystem } from '@/lib/filesystem';
import { Shell } from '@/lib/shell';
import Editor from '@/components/Editor';

// Dynamically import Terminal to avoid SSR issues with xterm.js
const Terminal = dynamicImport(() => import('@/components/Terminal'), {
  ssr: false,
});

export const dynamic = 'force-dynamic';

export default function Home() {
  const [fsReady, setFsReady] = useState(false);
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const shellRef = useRef<Shell | null>(null);

  useEffect(() => {
    initFileSystem().then(() => {
      setFsReady(true);
      shellRef.current = new Shell((path) => {
        setEditingFile(path);
      });
    });
  }, []);

  const handleCommand = async (cmd: string) => {
    if (!shellRef.current) return 'FileSystem not ready';
    return await shellRef.current.execute(cmd);
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-between p-4 bg-black">
      <div className="w-full h-[90vh] border border-gray-700 rounded overflow-hidden">
        {fsReady ? (
          <Terminal onCommand={handleCommand} />
        ) : (
          <div className="text-white p-4">Initializing FileSystem...</div>
        )}
      </div>
      
      {editingFile && (
        <Editor 
          filepath={editingFile} 
          onClose={() => setEditingFile(null)} 
        />
      )}
    </main>
  );
}
