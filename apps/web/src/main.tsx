import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';
import 'katex/dist/katex.min.css';
import './features/markdown/markdown.css';

// iOS Safari pans the window when an input is focused near the bottom of
// the viewport, even with body overflow:hidden + position:fixed. Snap the
// window back to (0, 0) any time it tries to drift. Cheap and bulletproof.
if (typeof window !== 'undefined') {
  const snap = (): void => {
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
  };
  window.addEventListener('scroll', snap, { passive: true });
  window.addEventListener('focusin', snap);
  window.visualViewport?.addEventListener('scroll', snap);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// Warm Shiki after first paint so the first markdown bubble doesn't pay the
// async-load cost. Fire-and-forget; failures fall through to the per-CodeBlock
// fallback (plain <pre>).
void import('./features/markdown/shiki-loader').then((m) => m.getHighlighter()).catch((err) => {
  console.warn('[shiki-warmup]', err);
});
