import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';
import 'katex/dist/katex.min.css';
import './features/markdown/markdown.css';

// Track the visual viewport so the app shell can size itself exactly to
// the on-screen area (excluding the keyboard) on iOS Safari. dvh alone
// is not reliable across iOS versions; visualViewport.height is.
if (typeof window !== 'undefined') {
  const setVVH = (): void => {
    const h = window.visualViewport?.height ?? window.innerHeight;
    document.documentElement.style.setProperty('--vvh', `${h}px`);
  };
  setVVH();
  window.addEventListener('resize', setVVH);
  window.visualViewport?.addEventListener('resize', setVVH);
  window.visualViewport?.addEventListener('scroll', setVVH);
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
