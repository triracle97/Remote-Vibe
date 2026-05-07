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
    return <div className="file-preview-empty">Select a file</div>;
  }
  if (file.state === 'loading') {
    return <div className="file-preview-loading">Loading {file.path}…</div>;
  }
  if (file.state === 'text') {
    return (
      <div className="file-preview">
        <div className="file-preview-header">
          {file.path} · {humanSize(file.bytesRead)}
        </div>
        <pre className="file-preview-pre">{file.content}</pre>
      </div>
    );
  }
  if (file.state === 'binary') {
    return (
      <div className="file-preview-binary">
        <div className="file-preview-header">{file.path}</div>
        <p>
          binary file ({humanSize(file.size)}
          {file.mime ? `, ${file.mime}` : ''})
        </p>
      </div>
    );
  }
  return (
    <div className="file-preview-binary">
      <div className="file-preview-header">{file.path}</div>
      <p>file too large ({humanSize(file.size)} / 5 MB max)</p>
    </div>
  );
}
