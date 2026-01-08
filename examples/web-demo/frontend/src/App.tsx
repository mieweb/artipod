import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { api, Pod } from './api';
import FilesystemPanel from './components/FilesystemPanel';
import PodPanel from './components/PodPanel';
import ContainersPanel from './components/ContainersPanel';

type View = 'filesystem' | 'containers' | 'pod';

function App() {
  const [view, setView] = useState<View>('filesystem');
  const [selectedPodId, setSelectedPodId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: pods = [] } = useQuery({
    queryKey: ['pods'],
    queryFn: () => api.getPods(),
    refetchInterval: 2000,
  });

  const { data: selectedPod } = useQuery({
    queryKey: ['pod', selectedPodId],
    queryFn: () => api.getPod(selectedPodId!),
    enabled: !!selectedPodId,
    refetchInterval: 2000,
  });

  const createPodMutation = useMutation({
    mutationFn: (data: { name: string; mounts: { name: string; path: string; readonly: boolean }[] }) =>
      api.createPod(data.name, data.mounts),
    onSuccess: (newPod) => {
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      // Navigate to the newly created pod
      setSelectedPodId(newPod.id);
      setView('pod');
    },
  });

  const selectPod = (podId: string) => {
    setSelectedPodId(podId);
    setView('pod');
  };

  return (
    <>
      <Toaster position="top-right" />
      <div className="app" role="application" aria-label="ArtiPod Demo Application">
      <aside className="sidebar" role="navigation" aria-label="Main navigation and pod list">
        <h1>ArtiPod Demo</h1>
        
        <button
          className={`nav-button nav-filesystem ${view === 'filesystem' ? 'active' : ''}`}
          onClick={() => {
            setView('filesystem');
            setSelectedPodId(null);
          }}
          aria-label="Navigate to Filesystem view"
          aria-current={view === 'filesystem' ? 'page' : undefined}
        >
          📁 Filesystem
        </button>

        <button
          className={`nav-button nav-containers ${view === 'containers' ? 'active' : ''}`}
          onClick={() => {
            setView('containers');
            setSelectedPodId(null);
          }}
          aria-label="Navigate to Containers view"
          aria-current={view === 'containers' ? 'page' : undefined}
        >
          🐳 Containers
        </button>

        <h2>Pods</h2>
        <div role="list" aria-label="Available pods">
          {pods.map((pod: Pod) => (
            <div
              key={pod.id}
              role="listitem"
              className={`pod-item ${selectedPodId === pod.id ? 'selected' : ''}`}
              onClick={() => selectPod(pod.id)}
              onKeyDown={(e) => e.key === 'Enter' && selectPod(pod.id)}
              tabIndex={0}
              aria-label={`Pod: ${pod.name}`}
              aria-selected={selectedPodId === pod.id}
            >
              <div style={{ fontWeight: 600 }}>{pod.name}</div>
              <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                {new Date(pod.created_at).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main className="main-content">
        {view === 'filesystem' && <FilesystemPanel onPodCreated={createPodMutation.mutate} />}
        {view === 'containers' && <ContainersPanel />}
        {view === 'pod' && selectedPod && (
          <PodPanel 
            pod={selectedPod} 
            onDelete={() => {
              setView('filesystem');
              setSelectedPodId(null);
            }}
          />
        )}
      </main>
    </div>
    </>
  );
}

export default App;
