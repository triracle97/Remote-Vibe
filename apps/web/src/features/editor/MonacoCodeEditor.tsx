/**
 * MonacoCodeEditor — Monaco wrapper for code files.
 *
 * Ported from nimbalyst (`packages/runtime/src/editors/MonacoCodeEditor.tsx`).
 * Dropped on the way over: the Yjs collab binding, the extension-theme
 * registry, and the `ConfigTheme` coupling. Kept: the content-ownership
 * pattern and the diff mode, both of which this app needs for the same reason
 * nimbalyst did — an agent is editing the same files underneath the user.
 *
 * Content ownership:
 * - This component owns the editor's content while it is mounted.
 * - `lastKnownDiskContentRef` tracks what we believe is on disk, so a reload
 *   triggered by our own save is recognised as an echo and ignored instead of
 *   yanking the cursor.
 *
 * Importing this module pulls in all of Monaco. Load it lazily — see
 * `CodeEditorPane`.
 */

import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import Editor, { DiffEditor, type Monaco, type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditorType } from 'monaco-editor';
import { getMonacoLanguage, getMonacoTheme, type EditorTheme } from './monacoUtils';
import { configureMonaco, disableDiagnostics } from './monaco-loader';

// Monaco has to be pointed at local workers before any editor mounts. Doing it
// at module scope is safe: this module is only ever reached through a dynamic
// import, and `configureMonaco` is idempotent.
configureMonaco();

export interface MonacoDiffModeConfig {
  oldContent: string;
  newContent: string;
}

/** Imperative handle handed to the parent via `onEditorReady`. */
export interface MonacoEditorHandle {
  editor: MonacoEditorType.IStandaloneCodeEditor;
  monaco: Monaco;
  getContent(): string;
  setContent(next: string, options?: { force?: boolean }): void;
  openFind(): void;
  showDiff(oldContent: string, newContent: string): void;
  exitDiffMode(): void;
  acceptDiff(): string;
  rejectDiff(): string;
  goToNextDiff(): void;
  goToPreviousDiff(): void;
  getDiffChangeCount(): number;
}

export interface MonacoCodeEditorProps {
  filePath: string;
  initialContent: string;
  theme: EditorTheme;
  readOnly?: boolean;
  /** Monaco construction overrides for normal (non-diff) mode. */
  editorOptions?: MonacoEditorType.IStandaloneEditorConstructionOptions;
  onDirtyChange?: (isDirty: boolean) => void;
  onGetContent?: (getContent: () => string) => void;
  onEditorReady?: (handle: MonacoEditorHandle) => void;
  onDiffChangeCountUpdate?: (count: number) => void;
  /**
   * Cmd/Ctrl+S while the editor has focus. Monaco swallows the keystroke
   * before it reaches any document-level listener, so the parent cannot bind
   * this itself.
   */
  onSave?: () => void;
}

export function MonacoCodeEditor({
  filePath,
  initialContent,
  theme,
  readOnly = false,
  editorOptions,
  onDirtyChange,
  onGetContent,
  onEditorReady,
  onDiffChangeCountUpdate,
  onSave,
}: MonacoCodeEditorProps): JSX.Element {
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null);
  const diffEditorRef = useRef<MonacoEditorType.IStandaloneDiffEditor | null>(null);
  const [content, setContent] = useState(initialContent);
  const initialContentRef = useRef(initialContent);
  const isProgrammaticChangeRef = useRef(false);

  // What we believe is currently on disk, used to ignore echoes of our own saves.
  const lastKnownDiskContentRef = useRef<string>(initialContent);

  const [diffMode, setDiffMode] = useState<MonacoDiffModeConfig | null>(null);
  const [diffChangeCount, setDiffChangeCount] = useState(0);
  const diffChangeIndexRef = useRef(-1); // -1 = nothing selected

  // `onSave` is read through a ref: the Monaco command is registered once at
  // mount, and a stale closure there would keep calling the first render's
  // save handler forever.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const language = useMemo(() => getMonacoLanguage(filePath), [filePath]);
  const monacoTheme = useMemo(() => getMonacoTheme(theme), [theme]);

  /**
   * Read the editor's current text.
   *
   * Also refreshes the disk-state tracker, because every caller of this is
   * about to persist what it gets back.
   */
  const getContent = useCallback((): string => {
    let result: string;
    if (diffMode && diffEditorRef.current) {
      result = diffEditorRef.current.getModifiedEditor().getValue();
    } else if (!editorRef.current) {
      result = content;
    } else {
      result = editorRef.current.getValue();
    }
    lastKnownDiskContentRef.current = result;
    return result;
  }, [content, diffMode]);

  /**
   * Replace the editor's content from the outside (a re-read after a conflict,
   * say). Content matching what we last wrote is treated as an echo and
   * dropped, unless forced.
   */
  const setEditorContent = useCallback(
    (newContent: string, options?: { force?: boolean }): void => {
      if (!options?.force && newContent === lastKnownDiskContentRef.current) return;

      setContent(newContent);
      lastKnownDiskContentRef.current = newContent;
      initialContentRef.current = newContent;

      if (editorRef.current && !diffMode) {
        const currentValue = editorRef.current.getValue();
        if (currentValue !== newContent) {
          isProgrammaticChangeRef.current = true;
          // `executeEdits` instead of `setValue` so the change joins the undo
          // stack and the cursor/scroll position survives.
          const model = editorRef.current.getModel();
          if (model) {
            editorRef.current.executeEdits('external-reload', [
              { range: model.getFullModelRange(), text: newContent },
            ]);
            editorRef.current.pushUndoStop();
          } else {
            editorRef.current.setValue(newContent);
          }
          setTimeout(() => {
            isProgrammaticChangeRef.current = false;
          }, 0);
        }
      }
      onDirtyChange?.(false);
    },
    [diffMode, onDirtyChange],
  );

  /** Show an inline diff between two revisions (e.g. against the agent's edit). */
  const showDiff = useCallback((oldContent: string, newContent: string): void => {
    setDiffMode({ oldContent, newContent });
  }, []);

  const exitDiffMode = useCallback((): void => {
    // Clear the model before unmount, or Monaco throws during disposal.
    if (diffEditorRef.current) {
      try {
        diffEditorRef.current.setModel(null);
      } catch (error) {
        console.warn('[MonacoCodeEditor] error clearing diff model:', error);
      }
      diffEditorRef.current = null;
    }
    setDiffChangeCount(0);
    diffChangeIndexRef.current = -1;
    setDiffMode(null);
  }, []);

  /** Accept the diff: the modified side wins. */
  const acceptDiff = useCallback((): string => {
    let result: string;
    if (diffEditorRef.current) {
      result = diffEditorRef.current.getModifiedEditor().getValue();
    } else if (diffMode) {
      result = diffMode.newContent;
    } else {
      result = content;
    }
    lastKnownDiskContentRef.current = result;
    return result;
  }, [diffMode, content]);

  /** Reject the diff: the original side wins. */
  const rejectDiff = useCallback((): string => {
    let result: string;
    if (diffEditorRef.current) {
      result = diffEditorRef.current.getOriginalEditor().getValue();
    } else if (diffMode) {
      result = diffMode.oldContent;
    } else {
      result = content;
    }
    lastKnownDiskContentRef.current = result;
    return result;
  }, [diffMode, content]);

  const goToNextDiff = useCallback((): void => {
    if (!diffEditorRef.current) return;
    diffEditorRef.current.goToDiff('next');
    // Monaco does not expose the current index, so track it by hand.
    if (diffChangeCount > 0) {
      diffChangeIndexRef.current = Math.min(diffChangeIndexRef.current + 1, diffChangeCount - 1);
      if (diffChangeIndexRef.current < 0) diffChangeIndexRef.current = 0;
    }
  }, [diffChangeCount]);

  const goToPreviousDiff = useCallback((): void => {
    if (!diffEditorRef.current) return;
    diffEditorRef.current.goToDiff('previous');
    if (diffChangeCount > 0) {
      diffChangeIndexRef.current = Math.max(diffChangeIndexRef.current - 1, 0);
    }
  }, [diffChangeCount]);

  const getDiffChangeCount = useCallback((): number => diffChangeCount, [diffChangeCount]);

  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      disableDiagnostics();

      // Cmd/Ctrl+S. Registered on the editor, not the document, because Monaco
      // consumes the keystroke while focused.
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSaveRef.current?.();
      });

      onGetContent?.(getContent);
      onEditorReady?.({
        editor,
        monaco,
        getContent,
        setContent: setEditorContent,
        openFind: () => {
          editor.focus();
          void editor
            .getAction('actions.find')
            ?.run()
            .catch((error: unknown) => {
              console.error('[MonacoCodeEditor] failed to open find widget:', error);
            });
        },
        showDiff,
        exitDiffMode,
        acceptDiff,
        rejectDiff,
        goToNextDiff,
        goToPreviousDiff,
        getDiffChangeCount,
      });

      editor.onDidChangeModelContent(() => {
        if (isProgrammaticChangeRef.current) return;
        onDirtyChange?.(editor.getValue() !== initialContentRef.current);
      });
    },
    [
      getContent,
      setEditorContent,
      onGetContent,
      onEditorReady,
      onDirtyChange,
      showDiff,
      exitDiffMode,
      acceptDiff,
      rejectDiff,
      goToNextDiff,
      goToPreviousDiff,
      getDiffChangeCount,
    ],
  );

  const handleDiffEditorMount = useCallback(
    (editor: MonacoEditorType.IStandaloneDiffEditor) => {
      diffEditorRef.current = editor;
      disableDiagnostics();

      editor.onDidUpdateDiff(() => {
        const count = editor.getLineChanges()?.length ?? 0;
        setDiffChangeCount(count);
        onDiffChangeCountUpdate?.(count);
        diffChangeIndexRef.current = count > 0 ? 0 : -1;
      });

      // The diff is computed asynchronously; jumping immediately lands on
      // nothing. One tick after mount is enough in practice.
      setTimeout(() => {
        try {
          editor.revealFirstDiff();
        } catch {
          // Editor disposed before the diff finished — nothing to reveal.
        }
      }, 100);
    },
    [onDiffChangeCountUpdate],
  );

  // A new file in the same mounted pane: reset ownership state wholesale.
  useEffect(() => {
    initialContentRef.current = initialContent;
    lastKnownDiskContentRef.current = initialContent;
    setContent(initialContent);
    setDiffMode(null);
  }, [filePath, initialContent]);

  // Unmount: clear the diff model first, or Monaco throws on disposal.
  useEffect(() => {
    return () => {
      if (diffEditorRef.current) {
        try {
          diffEditorRef.current.setModel(null);
        } catch (error) {
          console.warn('[MonacoCodeEditor] error clearing diff model on unmount:', error);
        }
      }
    };
  }, []);

  const sharedOptions: MonacoEditorType.IStandaloneEditorConstructionOptions = {
    automaticLayout: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, Menlo, Consolas, monospace",
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    renderValidationDecorations: 'off',
    glyphMargin: false,
    accessibilitySupport: 'auto',
    unusualLineTerminators: 'auto',
  };

  return (
    <div
      className="monaco-code-editor h-full w-full min-h-0"
      data-file-path={filePath}
      data-diff-mode={diffMode ? 'true' : 'false'}
    >
      {diffMode ? (
        <DiffEditor
          height="100%"
          language={language}
          original={diffMode.oldContent}
          modified={diffMode.newContent}
          theme={monacoTheme}
          onMount={handleDiffEditorMount}
          options={{
            ...sharedOptions,
            minimap: { enabled: false },
            wordWrap: 'on',
            // Side-by-side needs width this app does not have on a phone.
            renderSideBySide: false,
            readOnly: true,
            enableSplitViewResizing: false,
            renderOverviewRuler: true,
          }}
        />
      ) : (
        <Editor
          height="100%"
          language={language}
          value={content}
          theme={monacoTheme}
          onMount={handleEditorMount}
          options={{
            ...sharedOptions,
            readOnly,
            minimap: { enabled: false },
            wordWrap: 'on',
            tabSize: 2,
            insertSpaces: true,
            detectIndentation: true,
            renderWhitespace: 'selection',
            renderControlCharacters: false,
            folding: true,
            bracketPairColorization: { enabled: true },
            ...editorOptions,
          }}
        />
      )}
    </div>
  );
}

export default MonacoCodeEditor;
