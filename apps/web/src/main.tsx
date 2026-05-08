import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';
import './App.css';
import 'katex/dist/katex.min.css';
import './features/markdown/markdown.css';
import './features/profiles/profiles.css';

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
