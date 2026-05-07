import { useEffect } from 'react';
import { useFileExplorerStore, type DirEntry } from '../../store/file-explorer';
import type { BridgeClient } from '../../services/bridge-client';
import { FilePreview } from './FilePreview';
import './FileExplorer.css';

interface FileExplorerProps {
  client: BridgeClient;
  rootPath: string;
  onClose(): void;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DirRowsProps {
  client: BridgeClient;
  path: string;
  depth: number;
}

function DirRows({ client, path, depth }: DirRowsProps): JSX.Element {
  const dirs = useFileExplorerStore((s) => s.dirs[path]);
  const expanded = useFileExplorerStore((s) => s.expanded);
  const loadingPaths = useFileExplorerStore((s) => s.loadingPaths);
  const requestDirs = useFileExplorerStore((s) => s.requestDirs);
  const requestFile = useFileExplorerStore((s) => s.requestFile);
  const toggleExpand = useFileExplorerStore((s) => s.toggleExpand);
  const selectedFile = useFileExplorerStore((s) => s.selectedFile);

  if (loadingPaths[path]) {
    return (
      <div className="fe-row fe-row-loading" style={{ paddingLeft: depth * 14 + 12 }}>
        loading…
      </div>
    );
  }
  if (!dirs) return <></>;

  return (
    <>
      {dirs.map((entry) => {
        const childPath = path.endsWith('/') ? `${path}${entry.name}` : `${path}/${entry.name}`;
        const isExpanded = Boolean(expanded[childPath]);
        const isSelected = selectedFile && 'path' in selectedFile && selectedFile.path === childPath;
        return (
          <div key={childPath}>
            <button
              type="button"
              className={`fe-row${isSelected ? ' selected' : ''}`}
              style={{ paddingLeft: depth * 14 + 4 }}
              onClick={() => {
                if (entry.kind === 'dir') {
                  if (isExpanded) {
                    toggleExpand(childPath);
                  } else if (!useFileExplorerStore.getState().dirs[childPath]) {
                    requestDirs(client, childPath);
                  } else {
                    toggleExpand(childPath);
                  }
                } else {
                  requestFile(client, childPath);
                }
              }}
            >
              <span className="fe-caret">{entry.kind === 'dir' ? (isExpanded ? '▼' : '▶') : ' '}</span>
              <span className="fe-name">{entry.name}</span>
              {entry.kind === 'file' && entry.size !== undefined && (
                <span className="fe-size">{humanSize(entry.size)}</span>
              )}
            </button>
            {entry.kind === 'dir' && isExpanded && (
              <DirRows client={client} path={childPath} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </>
  );
}

export function FileExplorer({ client, rootPath, onClose }: FileExplorerProps): JSX.Element {
  const dirs = useFileExplorerStore((s) => s.dirs);
  const requestDirs = useFileExplorerStore((s) => s.requestDirs);
  const selectedFile = useFileExplorerStore((s) => s.selectedFile);

  useEffect(() => {
    if (!dirs[rootPath]) {
      requestDirs(client, rootPath);
    }
  }, [client, rootPath, dirs, requestDirs]);

  return (
    <aside className="file-explorer">
      <div className="fe-header">
        <code className="fe-root">{rootPath}</code>
        <button
          type="button"
          onClick={() => useFileExplorerStore.getState().refreshOpen(client)}
          title="Refresh open subtree"
        >
          ↻
        </button>
        <button type="button" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="fe-tree">
        <DirRows client={client} path={rootPath} depth={0} />
      </div>
      <div className="fe-preview">
        <FilePreview file={selectedFile} />
      </div>
    </aside>
  );
}
