import { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { X } from 'lucide-react';
import { useFileExplorerStore, type DirEntry } from '../../store/file-explorer';
import type { BridgeClient } from '../../services/bridge-client';
import { FilePreview } from './FilePreview';
import { BottomSheet } from '../../shell/BottomSheet';

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

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(min-width: 768px)');
    const onChange = (e: MediaQueryListEvent): void => setIsDesktop(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
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
      <div
        className="fe-row-loading flex items-center px-3 min-h-[44px] text-sm font-mono text-[var(--color-text-dim)] italic"
        style={{ paddingLeft: depth * 14 + 12 }}
      >
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
              className={`fe-row flex items-center gap-2 w-full text-left min-h-[44px] py-2 text-sm font-mono border-b border-[var(--color-border)] last:border-b-0 ${
                isSelected
                  ? 'bg-[var(--color-accent)]/15 text-[var(--color-text)]'
                  : 'text-[var(--color-text)] hover:bg-[var(--color-surface-2)]'
              }`}
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
              <span className="fe-caret inline-block w-[0.7rem] text-[var(--color-text-dim)]">
                {entry.kind === 'dir' ? (isExpanded ? '▼' : '▶') : ' '}
              </span>
              <span className="fe-name flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</span>
              {entry.kind === 'file' && entry.size !== undefined && (
                <span className="fe-size text-[var(--color-text-dim)] text-[0.7rem] pr-2">{humanSize(entry.size)}</span>
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
  const isDesktop = useIsDesktop();
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!dirs[rootPath]) {
      requestDirs(client, rootPath);
    }
  }, [client, rootPath, dirs, requestDirs]);

  const body = (
    <div className="file-explorer-body bg-[var(--color-surface)] text-[var(--color-text)] h-full flex flex-col min-h-0">
      {/* Header: root path + refresh + close */}
      <div className="fe-header flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
        <code className="fe-root flex-1 text-xs text-[var(--color-text-dim)] font-mono overflow-hidden text-ellipsis whitespace-nowrap">
          {rootPath}
        </code>
        <button
          type="button"
          onClick={() => useFileExplorerStore.getState().refreshOpen(client)}
          title="Refresh open subtree"
          className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] rounded bg-transparent border-0 cursor-pointer"
        >
          ↻
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close file explorer"
          className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] rounded"
        >
          <X size={18} />
        </button>
      </div>
      {/* Tree */}
      <div className="fe-tree flex-1 overflow-y-auto py-1">
        <DirRows client={client} path={rootPath} depth={0} />
      </div>
      {/* Preview */}
      <div className="fe-preview border-t border-[var(--color-border)] flex-1 min-h-0 overflow-auto">
        <FilePreview file={selectedFile} />
      </div>
    </div>
  );

  if (!isDesktop) {
    return (
      <BottomSheet open={true} onClose={onClose} ariaLabel="File Explorer" maxHeight="85dvh">
        {body}
      </BottomSheet>
    );
  }

  return (
    <AnimatePresence>
      <motion.aside
        key="file-explorer-pane"
        role="complementary"
        aria-label="File Explorer"
        className="file-explorer hidden md:flex fixed top-0 right-0 h-[100dvh] w-[min(28rem,90vw)] bg-[var(--color-surface)] border-l border-[var(--color-border)] shadow-2xl z-40 flex-col"
        initial={reduce ? false : { x: '100%' }}
        animate={{ x: 0 }}
        exit={reduce ? { x: 0 } : { x: '100%' }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
      >
        {body}
      </motion.aside>
    </AnimatePresence>
  );
}
