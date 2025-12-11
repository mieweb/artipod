import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api, ContainerInfo } from '../api';

function ContainersPanel() {
  const queryClient = useQueryClient();

  const { data: containers = [], isLoading } = useQuery({
    queryKey: ['containers'],
    queryFn: () => api.getAllContainers(),
    refetchInterval: 2000,
  });

  const removeContainerMutation = useMutation({
    mutationFn: (containerId: string) => api.removeContainer(containerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['containers'] });
      queryClient.invalidateQueries({ queryKey: ['pods'] });
      toast.success('Container removed');
    },
    onError: (error: Error) => {
      toast.error(`Failed to remove container: ${error.message}`);
    },
  });

  const handleRemove = (containerId: string) => {
    if (confirm('Are you sure you want to remove this container?')) {
      removeContainerMutation.mutate(containerId);
    }
  };

  if (isLoading) {
    return (
      <>
        <div className="header">
          <h2>Containers</h2>
        </div>
        <div className="content">
          <div style={{ padding: 20, opacity: 0.6 }}>Loading containers...</div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="header">
        <h2>Containers</h2>
      </div>
      <div className="content filesystem-content">
        <div className="filesystem-layout">
          <div className="filesystem-tree" style={{ minWidth: '100%' }}>
            <div className="tree-header">
              <h3>All ArtiPod Containers ({containers.length})</h3>
            </div>
            <div className="tree-container">
              {containers.length === 0 ? (
                <div className="empty-state">No containers found</div>
              ) : (
                <div className="containers-list">
                  {containers.map((container: ContainerInfo) => (
                    <div key={container.id} className="container-item">
                      <div className="container-info">
                        <span className="tree-node-icon">🐳</span>
                        <strong className="container-id">{container.id}</strong>
                        <span className={`status-badge status-${container.status}`}>
                          {container.status}
                        </span>
                        <span className="container-name">{container.name.replace(/^\//, '')}</span>
                        {container.labels['artipod.created_at'] && (
                          <span className="container-created">
                            {new Date(container.labels['artipod.created_at']).toLocaleString()}
                          </span>
                        )}
                      </div>
                      <button
                        className="btn btn-danger"
                        onClick={() => handleRemove(container.id)}
                        disabled={removeContainerMutation.isPending}
                        aria-label={`Remove container ${container.id}`}
                        style={{ fontSize: '12px', padding: '4px 10px', minWidth: '70px' }}
                      >
                        {removeContainerMutation.isPending ? '...' : '✕ Remove'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

export default ContainersPanel;
