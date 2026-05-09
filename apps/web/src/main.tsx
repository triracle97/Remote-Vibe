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
//
// Sizing #root to vvh is necessary but NOT sufficient: iOS Safari still
// pans the window when focusing an input near the bottom edge, lifting
// the chat input off-screen and exposing area below it. Snap window
// scroll back to (0, 0) on every drift event to keep the input pinned.
if (typeof window !== 'undefined') {
  const setVVH = (): void => {
    const h = window.visualViewport?.height ?? window.innerHeight;
    document.documentElement.style.setProperty('--vvh', `${h}px`);
  };
  const snap = (): void => {
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      window.scrollTo(0, 0);
    }
  };
  setVVH();
  window.addEventListener('resize', setVVH);
  window.visualViewport?.addEventListener('resize', setVVH);
  window.visualViewport?.addEventListener('scroll', () => {
    setVVH();
    snap();
  });
  window.addEventListener('scroll', snap, { passive: true });
  window.addEventListener('focusin', snap);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
