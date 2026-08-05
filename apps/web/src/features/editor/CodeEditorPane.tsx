import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Save, RotateCcw, AlertTriangle } from 'lucide-react';
import { useFileExplorerStore, type SelectedFile } from '../../store/file-explorer';
import type { BridgeClient } from '../../services/bridge-client';
import { currentEditorTheme, type EditorTheme } from './monacoUtils';

/**
 * Monaco lives behind this boundary and nowhere else.
 *
 * `React.lazy` puts `MonacoCodeEditor` — and through it all of `monaco-editor`
 * plus its five workers — into its own chunk, fetched the first time a text
 * file is opened. The main bundle is already 2.3 MB; Monaco must not join it.
 */
const MonacoCodeEditor = lazy(() => import('./MonacoCodeEditor'));

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Track `<html data-theme>` so the editor follows the app's theme toggle. */
function useEditorTheme(): EditorTheme {
  const [theme, setTheme] = useState<EditorTheme>(() => currentEditorTheme());
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const observer = new MutationObserver(() => setTheme(currentEditorTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

interface CodeEditorPaneProps {
  client: BridgeClient;
  file: Extract<SelectedFile, { state: 'text' }>;
}

export function CodeEditorPane({ client, file }: CodeEditorPaneProps): JSX.Element {
  const editorState = useFileExplorerStore((s) => s.editor);
  const setDirty = useFileExplorerStore((s) => s.setDirty);
  const saveFile = useFileExplorerStore((s) => s.saveFile);
  const clearEditorError = useFileExplorerStore((s) => s.clearEditorError);
  const requestFile = useFileExplorerStore((s) => s.requestFile);
  const theme = useEditorTheme();

  // Monaco hands us a content accessor rather than streaming every keystroke
  // through React — the whole point of the ownership pattern in the editor.
  const getContentRef = useRef<(() => string) | null>(null);
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);

  const doSave = useCallback(
    (force: boolean) => {
      const content = getContentRef.current?.();
      if (content === undefined) return;
      setConfirmingOverwrite(false);
      saveFile(client, content, { force });
    },
    [client, saveFile],
  );

  /**
   * Saving is a confirmed action, per the decision to widen the bridge's blast
   * radius only behind an explicit step. The first press asks; the second
   * writes.
   *
   * Only the post-conflict press forces. Confirming an ordinary save still
   * carries the hash, so a file that changed between the two presses is caught
   * rather than silently clobbered — the confirmation is about intent, not
   * about waiving the concurrency check.
   */
  const onSaveRequest = useCallback(() => {
    if (editorState.saving) return;
    if (editorState.conflict) {
      doSave(true);
      return;
    }
    if (confirmingOverwrite) {
      doSave(false);
      return;
    }
    setConfirmingOverwrite(true);
  }, [confirmingOverwrite, doSave, editorState.conflict, editorState.saving]);

  // A new file, or a fresh read after a conflict, cancels a pending confirm.
  useEffect(() => {
    setConfirmingOverwrite(false);
  }, [file.path, file.hash]);

  // Warn before the tab closes with unsaved edits. Cheap insurance on a phone,
  // where an accidental swipe-away is easy.
  useEffect(() => {
    if (!editorState.dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [editorState.dirty]);

  const saveLabel = editorState.saving
    ? 'Saving…'
    : editorState.conflict
      ? 'Overwrite anyway'
      : confirmingOverwrite
        ? 'Confirm save'
        : 'Save';

  return (
    <div className="code-editor-pane flex flex-col min-h-0 h-full">
      <div className="cep-header flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
        <span
          className="cep-path flex-1 text-xs text-[var(--color-text-dim)] font-mono overflow-hidden text-ellipsis whitespace-nowrap"
          title={file.path}
        >
          {editorState.dirty && (
            <span className="cep-dirty text-[var(--color-warn)] pr-1" aria-label="unsaved changes">
              ●
            </span>
          )}
          {file.path} · {humanSize(file.bytesRead)}
        </span>
        {editorState.dirty && !editorState.saving && (
          <button
            type="button"
            onClick={() => requestFile(client, file.path)}
            title="Discard changes and re-read the file from disk"
            aria-label="Discard changes"
            className="min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--color-text-dim)] hover:text-[var(--color-text)] rounded bg-transparent border-0 cursor-pointer"
          >
            <RotateCcw size={16} />
          </button>
        )}
        <button
          type="button"
          onClick={onSaveRequest}
          disabled={!editorState.dirty || editorState.saving}
          title={`${saveLabel} (⌘S)`}
          className={`cep-save min-h-[44px] px-3 flex items-center gap-1.5 text-xs font-mono rounded border cursor-pointer disabled:opacity-40 disabled:cursor-default ${
            confirmingOverwrite || editorState.conflict
              ? 'border-[var(--color-warn)] text-[var(--color-warn)] bg-[var(--color-warn)]/10'
              : 'border-[var(--color-border)] text-[var(--color-text)] bg-[var(--color-surface-2)]'
          }`}
        >
          <Save size={14} />
          {saveLabel}
        </button>
      </div>

      {(confirmingOverwrite || editorState.error) && (
        <div
          role="status"
          className={`cep-notice flex items-start gap-2 px-3 py-2 text-xs font-mono border-b border-[var(--color-border)] ${
            editorState.error
              ? 'text-[var(--color-danger)] bg-[var(--color-danger)]/10'
              : 'text-[var(--color-warn)] bg-[var(--color-warn)]/10'
          }`}
        >
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span className="flex-1">
            {editorState.error
              ? `${editorState.error}${editorState.conflict ? ' Saving again overwrites the newer version on disk.' : ''}`
              : `Overwrite ${file.path} on disk?`}
          </span>
          {editorState.conflict && (
            <button
              type="button"
              onClick={() => {
                clearEditorError();
                requestFile(client, file.path);
              }}
              className="shrink-0 underline text-[var(--color-text-dim)] hover:text-[var(--color-text)] bg-transparent border-0 cursor-pointer"
            >
              Reload
            </button>
          )}
          {!editorState.error && (
            <button
              type="button"
              onClick={() => setConfirmingOverwrite(false)}
              className="shrink-0 underline text-[var(--color-text-dim)] hover:text-[var(--color-text)] bg-transparent border-0 cursor-pointer"
            >
              Cancel
            </button>
          )}
        </div>
      )}

      <div className="cep-editor flex-1 min-h-0">
        <Suspense
          fallback={
            <div className="p-3 text-xs font-mono text-[var(--color-text-dim)]">Loading editor…</div>
          }
        >
          <MonacoCodeEditor
            // Remount on path change so Monaco rebuilds its model against the
            // new language instead of re-tokenising the old one.
            key={file.path}
            filePath={file.path}
            initialContent={file.content}
            theme={theme}
            onDirtyChange={setDirty}
            onGetContent={(fn) => {
              getContentRef.current = fn;
            }}
            onSave={onSaveRequest}
          />
        </Suspense>
      </div>
    </div>
  );
}

export default CodeEditorPane;
