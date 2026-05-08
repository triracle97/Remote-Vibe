import type { SelectedFile } from '../../store/file-explorer';

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FilePreviewProps {
  file: SelectedFile | null;
}

export function FilePreview({ file }: FilePreviewProps): JSX.Element {
  if (!file) {
    return (
      <div className="file-preview-empty p-3 text-[var(--color-text-dim)] text-sm font-mono">
        Select a file
      </div>
    );
  }
  if (file.state === 'loading') {
    return (
      <div className="file-preview-loading p-3 text-[var(--color-text-dim)] text-sm font-mono">
        Loading {file.path}…
      </div>
    );
  }
  if (file.state === 'text') {
    return (
      <div className="file-preview flex flex-col min-h-0">
        <div className="file-preview-header text-xs text-[var(--color-text-dim)] px-3 py-2 border-b border-[var(--color-border)] truncate font-mono">
          {file.path} · {humanSize(file.bytesRead)}
        </div>
        <pre className="file-preview-pre flex-1 min-h-0 overflow-auto p-3 text-xs font-mono text-[var(--color-text)] whitespace-pre-wrap break-words m-0">
          {file.content}
        </pre>
      </div>
    );
  }
  if (file.state === 'binary') {
    return (
      <div className="file-preview-binary flex flex-col min-h-0">
        <div className="file-preview-header text-xs text-[var(--color-text-dim)] px-3 py-2 border-b border-[var(--color-border)] truncate font-mono">
          {file.path}
        </div>
        <p className="p-3 text-xs font-mono text-[var(--color-text-dim)] m-0">
          binary file ({humanSize(file.size)}
          {file.mime ? `, ${file.mime}` : ''})
        </p>
      </div>
    );
  }
  return (
    <div className="file-preview-binary flex flex-col min-h-0">
      <div className="file-preview-header text-xs text-[var(--color-text-dim)] px-3 py-2 border-b border-[var(--color-border)] truncate font-mono">
        {file.path}
      </div>
      <p className="p-3 text-xs font-mono text-[var(--color-text-dim)] m-0">
        file too large ({humanSize(file.size)} / 5 MB max)
      </p>
    </div>
  );
}
