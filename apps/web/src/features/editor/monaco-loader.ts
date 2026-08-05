import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// Vite's native worker support — each of these becomes its own bundle, pulled
// only when Monaco actually asks for that language service. No plugin needed.
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker.js?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker.js?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker.js?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';

/**
 * Monaco setup, ported from nimbalyst's `monacoConfig.ts`.
 *
 * This module is the heavy half of the editor: importing it pulls in all of
 * `monaco-editor`. Nothing may import it at module scope from code that is
 * reachable from the app entry — it is reached only through the dynamic
 * `import()` inside `CodeEditorPane`, the same way `mermaid-loader` stays out
 * of the main chunk. Keep it that way; the bundle is already 2.3 MB.
 */

let configured = false;

/**
 * Point Monaco at local workers and at the locally-installed `monaco-editor`.
 *
 * The second part matters more than it looks: `@monaco-editor/react` defaults
 * to pulling Monaco off a public CDN at runtime. For a bridge that is meant to
 * be reachable over Tailscale and nothing else, that is both a dead dependency
 * when the phone is offline and an unwanted third-party fetch. `loader.config`
 * replaces it with the bundled copy.
 */
export function configureMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === 'json') return new jsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
      if (label === 'typescript' || label === 'javascript') return new tsWorker();
      return new editorWorker();
    },
  };

  loader.config({ monaco });

  return monaco;
}

/**
 * Turn off TS/JS diagnostics.
 *
 * The editor opens one file with no tsconfig, no `node_modules` and no sibling
 * sources, so every import resolves to nothing and the gutter fills with red
 * squiggles that are all false. Highlighting stays; only the checker goes.
 *
 * Takes no argument on purpose: the `monaco` handed to `onMount` by
 * `@monaco-editor/react` is typed as the api-only entry, where `typescript`
 * is a deprecated stub. The module-scope import here is `editor.main`, which
 * carries the real language-service namespace.
 */
export function disableDiagnostics(): void {
  try {
    const off = {
      noSemanticValidation: true,
      noSyntaxValidation: true,
      noSuggestionDiagnostics: true,
    };
    monaco.typescript.typescriptDefaults.setDiagnosticsOptions(off);
    monaco.typescript.javascriptDefaults.setDiagnosticsOptions(off);
  } catch (error) {
    console.warn('[monaco] failed to disable diagnostics:', error);
  }
}
